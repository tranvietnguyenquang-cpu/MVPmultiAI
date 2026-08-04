import { createHash } from "node:crypto";
import type { TruncationMethod } from "./review.js";

/**
 * Strict text-safety primitives shared by the execution-side evidence
 * producers and the reviewer-side materializer, so both sides agree byte for
 * byte on what "decodable text" means, how many bytes a rendered fragment
 * costs, and where a truncation boundary may fall.
 *
 * Nothing here uses `Buffer.toString("utf8")` on authoritative content:
 * that decoder silently replaces every invalid sequence with U+FFFD, which
 * both corrupts evidence and makes the decoded string's byte length differ
 * from the raw bytes that were hashed. Authoritative evidence must either
 * decode exactly or be rejected.
 */

/** The only C0 control bytes permitted inside authoritative evidence text: TAB, LF, CR. */
const ALLOWED_CONTROL_CODE_POINTS: ReadonlySet<number> = Object.freeze(new Set([0x09, 0x0a, 0x0d]));

const UTF8_BOM = Object.freeze([0xef, 0xbb, 0xbf]);

export type StrictTextRejectionCode =
  | "INVALID_UTF8"
  | "NUL_BYTE"
  | "DISALLOWED_CONTROL_BYTE"
  | "UNSUPPORTED_BOM";

export type StrictDecodeResult =
  | { ok: true; text: string }
  | { ok: false; code: StrictTextRejectionCode; reason: string };

/**
 * Decodes raw artifact bytes as strict UTF-8 text, or rejects them.
 *
 * Rejects, in order:
 *   - a leading UTF-8 BOM (policy: authoritative evidence is written by this
 *     application's own writers, which never emit one; a BOM in the store
 *     means the bytes came from somewhere else, or were rewritten by an
 *     editor, and their provenance is no longer trustworthy);
 *   - any invalid UTF-8 sequence (TextDecoder in `fatal` mode -- never a
 *     U+FFFD substitution);
 *   - any NUL byte;
 *   - any other C0/C1 control code point outside TAB/LF/CR, and U+007F DEL.
 *
 * Binary content is rejected by construction: real binary reliably trips
 * either the invalid-UTF-8 or the NUL/control check. `label` is used only to
 * build a human-readable reason.
 */
export function decodeStrictUtf8(bytes: Uint8Array, label: string): StrictDecodeResult {
  if (bytes.length >= 3 && bytes[0] === UTF8_BOM[0] && bytes[1] === UTF8_BOM[1] && bytes[2] === UTF8_BOM[2]) {
    return { ok: false, code: "UNSUPPORTED_BOM", reason: `${label} begins with a UTF-8 byte-order mark, which is not a supported encoding for authoritative evidence.` };
  }
  const nulIndex = bytes.indexOf(0);
  if (nulIndex !== -1) {
    return { ok: false, code: "NUL_BYTE", reason: `${label} contains a NUL byte at offset ${nulIndex} and is not decodable text; binary content cannot be used as authoritative evidence.` };
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { ok: false, code: "INVALID_UTF8", reason: `${label} is not valid UTF-8 and cannot be decoded as authoritative evidence.` };
  }
  for (const character of text) {
    const codePoint = character.codePointAt(0)!;
    const isC0 = codePoint < 0x20;
    const isDeleteOrC1 = codePoint >= 0x7f && codePoint <= 0x9f;
    if ((isC0 || isDeleteOrC1) && !ALLOWED_CONTROL_CODE_POINTS.has(codePoint)) {
      return {
        ok: false,
        code: "DISALLOWED_CONTROL_BYTE",
        reason: `${label} contains disallowed control character U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}; only TAB, LF, and CR are permitted in authoritative evidence text.`
      };
    }
  }
  return { ok: true, text };
}

/** UTF-8 byte length of a string, guarded against a non-finite/unsafe result. */
export function utf8ByteLength(text: string): number {
  const bytes = Buffer.byteLength(text, "utf8");
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("Computed UTF-8 byte length is not a safe non-negative integer; refusing to proceed.");
  return bytes;
}

/** SHA-256 over the ORIGINAL raw bytes -- never over a decoded/re-encoded string. */
export function sha256OfBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** SHA-256 over a string's UTF-8 encoding. Distinct from {@link sha256OfBytes} on purpose: the two differ whenever decoding was lossy, which is exactly the condition strict decoding exists to prevent. */
export function sha256OfText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Longest prefix of `text` whose UTF-8 encoding is at most `maxBytes`, cut
 * only on a complete Unicode code point. `for...of` over a string iterates by
 * code point (not UTF-16 code unit), so a surrogate pair is never split.
 */
function headByCodePoints(text: string, maxBytes: number): { text: string; byteCount: number } {
  if (maxBytes <= 0) return { text: "", byteCount: 0 };
  let byteCount = 0;
  let end = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character, "utf8");
    if (byteCount + size > maxBytes) break;
    byteCount += size;
    end += character.length;
  }
  return { text: text.slice(0, end), byteCount };
}

/** Longest suffix of `text` whose UTF-8 encoding is at most `maxBytes`, cut only on a complete Unicode code point. */
function tailByCodePoints(text: string, maxBytes: number): { text: string; byteCount: number } {
  if (maxBytes <= 0) return { text: "", byteCount: 0 };
  const characters = [...text];
  let byteCount = 0;
  let start = characters.length;
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    const size = Buffer.byteLength(characters[index]!, "utf8");
    if (byteCount + size > maxBytes) break;
    byteCount += size;
    start = index;
  }
  return { text: characters.slice(start).join(""), byteCount };
}

/**
 * The exact, self-describing result of bounding one text fragment. Every
 * count is measured, never inferred:
 *   - `originalByteCount` is the UTF-8 size of the COMPLETE input;
 *   - `includedContentByteCount` counts only real content bytes kept;
 *   - `markerByteCount` counts the inserted omission marker;
 *   - `finalRenderedByteCount` is the measured size of `text` itself and
 *     always equals `includedContentByteCount + markerByteCount`;
 *   - `omittedByteCount` is `originalByteCount - includedContentByteCount`,
 *     i.e. real content bytes the reader will never see. The marker is not
 *     content and therefore never reduces the omission count.
 */
export type BoundedText = {
  text: string;
  truncated: boolean;
  truncationMethod: TruncationMethod;
  originalByteCount: number;
  includedContentByteCount: number;
  markerByteCount: number;
  finalRenderedByteCount: number;
  omittedByteCount: number;
};

export function untruncatedText(text: string): BoundedText {
  const byteCount = utf8ByteLength(text);
  return {
    text, truncated: false, truncationMethod: "NONE", originalByteCount: byteCount,
    includedContentByteCount: byteCount, markerByteCount: 0, finalRenderedByteCount: byteCount, omittedByteCount: 0
  };
}

/**
 * Bounds `text` to at most `maxRenderedBytes` UTF-8 bytes INCLUDING the
 * omission marker, cutting only on complete Unicode code points.
 *
 * The marker's own bytes are charged against the budget first, so the
 * returned `finalRenderedByteCount` never exceeds `maxRenderedBytes` -- a
 * marker cannot push a fragment back over the cap it was inserted to respect.
 * `HEAD_AND_TAIL` splits the remaining content budget evenly, giving any odd
 * byte to the head.
 *
 * Throws if the marker alone cannot fit: that is a programming error in the
 * budget table, not a runtime condition to be silently degraded.
 */
export function boundTextToBytes(
  text: string,
  maxRenderedBytes: number,
  method: Extract<TruncationMethod, "HEAD" | "TAIL" | "HEAD_AND_TAIL">,
  omissionMarker: string
): BoundedText {
  const originalByteCount = utf8ByteLength(text);
  if (originalByteCount <= maxRenderedBytes) return untruncatedText(text);

  const markerByteCount = utf8ByteLength(omissionMarker);
  const contentBudget = maxRenderedBytes - markerByteCount;
  if (contentBudget <= 0) {
    throw new Error(`Omission marker (${markerByteCount} bytes) does not fit within the ${maxRenderedBytes}-byte render budget; the budget table is misconfigured.`);
  }

  let head = { text: "", byteCount: 0 };
  let tail = { text: "", byteCount: 0 };
  if (method === "HEAD") {
    head = headByCodePoints(text, contentBudget);
  } else if (method === "TAIL") {
    tail = tailByCodePoints(text, contentBudget);
  } else {
    const headBudget = Math.ceil(contentBudget / 2);
    head = headByCodePoints(text, headBudget);
    // Any budget the head could not use (because a code point straddled its
    // boundary) is handed to the tail rather than silently wasted.
    tail = tailByCodePoints(text, contentBudget - head.byteCount);
  }

  const rendered = `${head.text}${omissionMarker}${tail.text}`;
  const includedContentByteCount = head.byteCount + tail.byteCount;
  const finalRenderedByteCount = utf8ByteLength(rendered);
  // head + marker + tail must reproduce the declared size exactly; a mismatch
  // would mean the accounting below is fiction.
  if (finalRenderedByteCount !== includedContentByteCount + markerByteCount) {
    throw new Error("Bounded text accounting is inconsistent: rendered bytes do not equal included content bytes plus marker bytes.");
  }
  return {
    text: rendered,
    truncated: true,
    truncationMethod: method,
    originalByteCount,
    includedContentByteCount,
    markerByteCount,
    finalRenderedByteCount,
    omittedByteCount: originalByteCount - includedContentByteCount
  };
}
