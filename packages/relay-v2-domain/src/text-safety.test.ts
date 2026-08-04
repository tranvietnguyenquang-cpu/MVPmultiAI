import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { boundTextToBytes, decodeStrictUtf8, sha256OfBytes, sha256OfText, untruncatedText, utf8ByteLength } from "./text-safety.js";

const MARKER = "\n...[cut]...\n";
const MARKER_BYTES = Buffer.byteLength(MARKER, "utf8");

describe("decodeStrictUtf8", () => {
  it("accepts valid ASCII and multi-plane Unicode", () => {
    for (const sample of ["plain ascii", "héllo wörld", "→ ∑ ≈", "🌍🚀", "é combining", "日本語"]) {
      const result = decodeStrictUtf8(Buffer.from(sample, "utf8"), "sample");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.text).toBe(sample);
    }
  });

  it("rejects invalid UTF-8 instead of substituting U+FFFD", () => {
    const result = decodeStrictUtf8(Buffer.from([0x61, 0xff, 0xfe, 0x62]), "sample");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INVALID_UTF8");
    // The permissive decoder silently produces replacement characters here,
    // which is exactly the corruption strict decoding exists to prevent.
    expect(Buffer.from([0x61, 0xff, 0xfe, 0x62]).toString("utf8")).toContain("�");
  });

  it("rejects a truncated multibyte sequence", () => {
    const complete = Buffer.from("é", "utf8");
    const result = decodeStrictUtf8(complete.subarray(0, 1), "sample");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INVALID_UTF8");
  });

  it("rejects a NUL byte", () => {
    const result = decodeStrictUtf8(Buffer.from([0x61, 0x00]), "sample");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("NUL_BYTE");
  });

  it("rejects disallowed C0 control bytes", () => {
    for (const byte of [0x01, 0x07, 0x0b, 0x0c, 0x1b]) {
      const result = decodeStrictUtf8(Buffer.from([0x61, byte]), "sample");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("DISALLOWED_CONTROL_BYTE");
    }
  });

  it("rejects DEL and C1 control code points", () => {
    for (const codePoint of [0x7f, 0x85, 0x9f]) {
      const result = decodeStrictUtf8(Buffer.from(String.fromCodePoint(codePoint), "utf8"), "sample");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("DISALLOWED_CONTROL_BYTE");
    }
  });

  it("allows exactly TAB, LF, and CR", () => {
    expect(decodeStrictUtf8(Buffer.from("a\tb\nc\rd", "utf8"), "sample").ok).toBe(true);
  });

  it("rejects binary content", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
    expect(decodeStrictUtf8(png, "sample").ok).toBe(false);
  });

  it("rejects a UTF-8 BOM as an unsupported encoding", () => {
    const result = decodeStrictUtf8(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("text", "utf8")]), "sample");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("UNSUPPORTED_BOM");
  });

  it("accepts an empty buffer", () => {
    expect(decodeStrictUtf8(Buffer.alloc(0), "sample").ok).toBe(true);
  });
});

describe("raw-byte hashing versus decoded-text hashing", () => {
  it("agrees for content that round-trips exactly", () => {
    const bytes = Buffer.from("héllo → 🌍", "utf8");
    expect(sha256OfBytes(bytes)).toBe(sha256OfText(bytes.toString("utf8")));
  });

  it("differs the moment a permissive decode was lossy, which is why evidence hashes the raw bytes", () => {
    const bytes = Buffer.from([0x61, 0xff, 0xfe, 0x62]);
    const permissivelyDecoded = bytes.toString("utf8");
    expect(sha256OfBytes(bytes)).not.toBe(sha256OfText(permissivelyDecoded));
    expect(sha256OfBytes(bytes)).toBe(createHash("sha256").update(bytes).digest("hex"));
  });
});

describe("boundTextToBytes", () => {
  it("returns the whole text untouched when it already fits", () => {
    const bounded = boundTextToBytes("short", 100, "HEAD", MARKER);
    expect(bounded).toEqual(untruncatedText("short"));
    expect(bounded.truncated).toBe(false);
    expect(bounded.omittedByteCount).toBe(0);
  });

  it("accepts content at exactly the boundary without truncating", () => {
    const text = "x".repeat(50);
    const bounded = boundTextToBytes(text, 50, "HEAD", MARKER);
    expect(bounded.truncated).toBe(false);
    expect(bounded.text).toBe(text);
  });

  it("truncates content one byte over the boundary", () => {
    const bounded = boundTextToBytes("x".repeat(51), 50, "HEAD", MARKER);
    expect(bounded.truncated).toBe(true);
    expect(bounded.omittedByteCount).toBeGreaterThan(0);
  });

  it("keeps the whole render, marker included, within the budget", () => {
    for (const method of ["HEAD", "TAIL", "HEAD_AND_TAIL"] as const) {
      const bounded = boundTextToBytes("x".repeat(1_000), 200, method, MARKER);
      expect(bounded.finalRenderedByteCount).toBeLessThanOrEqual(200);
      expect(utf8ByteLength(bounded.text)).toBe(bounded.finalRenderedByteCount);
    }
  });

  it("counts the omission marker toward the rendered size but never toward the omission count", () => {
    const bounded = boundTextToBytes("x".repeat(1_000), 200, "HEAD", MARKER);
    expect(bounded.markerByteCount).toBe(MARKER_BYTES);
    expect(bounded.finalRenderedByteCount).toBe(bounded.includedContentByteCount + MARKER_BYTES);
    expect(bounded.omittedByteCount).toBe(bounded.originalByteCount - bounded.includedContentByteCount);
  });

  it("reproduces the declared byte count exactly from head + marker + tail", () => {
    const bounded = boundTextToBytes("abcdefghij".repeat(100), 300, "HEAD_AND_TAIL", MARKER);
    const [head, tail] = bounded.text.split(MARKER);
    expect(tail).toBeDefined();
    expect(utf8ByteLength(head!) + MARKER_BYTES + utf8ByteLength(tail!)).toBe(bounded.finalRenderedByteCount);
    expect(utf8ByteLength(head!) + utf8ByteLength(tail!)).toBe(bounded.includedContentByteCount);
  });

  describe("code-point safety", () => {
    /** Every truncation result must decode strictly -- a split code point would not. */
    function expectNoBrokenCodePoints(text: string) {
      expect(text).not.toContain("�");
      expect(decodeStrictUtf8(Buffer.from(text, "utf8"), "bounded").ok).toBe(true);
    }

    it("never splits a 2-byte character straddling the head boundary", () => {
      // "é" is 2 bytes; an odd budget puts the boundary mid-character.
      for (let budget = 40; budget < 60; budget += 1) {
        const bounded = boundTextToBytes("é".repeat(200), budget + MARKER_BYTES, "HEAD", MARKER);
        expectNoBrokenCodePoints(bounded.text);
        expect(bounded.includedContentByteCount % 2).toBe(0);
      }
    });

    it("never splits a 3-byte character straddling the head boundary", () => {
      for (let budget = 40; budget < 60; budget += 1) {
        const bounded = boundTextToBytes("→".repeat(200), budget + MARKER_BYTES, "HEAD", MARKER);
        expectNoBrokenCodePoints(bounded.text);
        expect(bounded.includedContentByteCount % 3).toBe(0);
      }
    });

    it("never splits an emoji (4-byte surrogate pair) at the head boundary", () => {
      for (let budget = 40; budget < 60; budget += 1) {
        const bounded = boundTextToBytes("🌍".repeat(200), budget + MARKER_BYTES, "HEAD", MARKER);
        expectNoBrokenCodePoints(bounded.text);
        expect(bounded.includedContentByteCount % 4).toBe(0);
      }
    });

    it("never splits a multibyte character at the tail boundary", () => {
      for (let budget = 40; budget < 60; budget += 1) {
        const bounded = boundTextToBytes("🌍".repeat(200), budget + MARKER_BYTES, "TAIL", MARKER);
        expectNoBrokenCodePoints(bounded.text);
      }
    });

    it("never splits a multibyte character at either head+tail boundary", () => {
      for (let budget = 60; budget < 90; budget += 1) {
        const bounded = boundTextToBytes("→🌍é".repeat(200), budget + MARKER_BYTES, "HEAD_AND_TAIL", MARKER);
        expectNoBrokenCodePoints(bounded.text);
      }
    });

    it("keeps combining sequences decodable, and never emits a lone surrogate", () => {
      const combining = "éáó".repeat(100);
      for (let budget = 40; budget < 70; budget += 1) {
        const bounded = boundTextToBytes(combining, budget + MARKER_BYTES, "HEAD_AND_TAIL", MARKER);
        expectNoBrokenCodePoints(bounded.text);
        for (const character of bounded.text) {
          const codePoint = character.codePointAt(0)!;
          expect(codePoint >= 0xd800 && codePoint <= 0xdfff).toBe(false);
        }
      }
    });

    it("reports omitted bytes against the complete source, in bytes rather than characters", () => {
      const source = "🌍".repeat(100);
      const bounded = boundTextToBytes(source, 100, "HEAD", MARKER);
      expect(bounded.originalByteCount).toBe(400);
      expect(source.length).toBe(200);
      expect(bounded.omittedByteCount).toBe(400 - bounded.includedContentByteCount);
    });
  });

  it("throws rather than silently degrading when the marker alone cannot fit", () => {
    expect(() => boundTextToBytes("x".repeat(100), MARKER_BYTES - 1, "HEAD", MARKER)).toThrow(/misconfigured/);
  });
});
