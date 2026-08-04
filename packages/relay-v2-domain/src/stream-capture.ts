import { z } from "zod";
import { truncationMethodSchema } from "./review.js";
import { sha256OfText, utf8ByteLength } from "./text-safety.js";

/**
 * Truthful provenance for one captured process output stream, from the bytes
 * the process actually wrote all the way to the bytes a reviewer is shown.
 *
 * The defect this contract exists to make impossible: a process-runner
 * boundary can discard output (SafeProcessRunner stops forwarding chunks once
 * the combined cap is reached, while still counting every byte the process
 * wrote), and a consumer that reads only `exitCode` from the exit event will
 * happily persist an EMPTY captured stream, `captureTruncated: false`, and a
 * PASSED status -- an evidence record that states, falsely, that the operation
 * produced no output. Nothing downstream can then tell the difference between
 * "this command printed nothing" and "this command's output was thrown away".
 *
 * Every count below is measured, never inferred, and the chain is closed:
 *
 *   rawByteCount        bytes the process wrote to this stream (runner-reported)
 *     - upstreamOmittedByteCount   bytes the runner never forwarded
 *   = deliveredByteCount           bytes the consumer actually received
 *     - redactionOmittedByteCount  bytes secret redaction removed
 *   = capturedByteCount            bytes the consumer holds
 *     - truncationOmittedByteCount bytes the consumer chose not to render
 *   = includedByteCount            bytes a reviewer is shown
 *
 * `deliveredByteCount` is nullable on purpose: a process-runner
 * implementation that does not report per-chunk raw sizes leaves the split
 * between "delivered then redacted" and "never delivered" genuinely unknown,
 * and an unknown is reported as unknown rather than guessed. That is exactly
 * the case `TRUNCATED_UNKNOWN` names, and an AUTHORITATIVE review refuses it.
 */

export const STREAM_CAPTURE_PROVENANCE_VERSION = "stream-capture-provenance-v1" as const;

const sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/);

/**
 * How completely this stream's output survived to the evidence record.
 *   - COMPLETE: every byte the process wrote reached the consumer, and every
 *     byte the consumer holds is rendered. Redaction may still have applied.
 *   - TRUNCATED_KNOWN: the consumer held the complete stream and deliberately
 *     rendered less of it. The omitted amount and the complete content's hash
 *     are both known, so the loss is fully described.
 *   - TRUNCATED_UNKNOWN: output was lost UPSTREAM of the consumer, or the
 *     attribution of an upstream loss between streams is not knowable. The
 *     complete content no longer exists anywhere and cannot be hashed.
 */
export const captureCompletenessSchema = z.enum(["COMPLETE", "TRUNCATED_KNOWN", "TRUNCATED_UNKNOWN"]);
export type CaptureCompleteness = z.infer<typeof captureCompletenessSchema>;

/**
 * Why a captured stream is empty. An empty stream with nonzero raw bytes is
 * never LEGITIMATE_EMPTY -- that would be lost (or wholly redacted) output
 * wearing emptiness as a disguise, which is precisely what this enum forbids
 * expressing.
 */
export const emptyOutputReasonSchema = z.enum(["NOT_EMPTY", "LEGITIMATE_EMPTY", "REDACTED_EMPTY", "LOST_UPSTREAM"]);
export type EmptyOutputReason = z.infer<typeof emptyOutputReasonSchema>;

export const streamCaptureProvenanceSchema = z.object({
  schemaVersion: z.literal(STREAM_CAPTURE_PROVENANCE_VERSION),
  stream: z.enum(["stdout", "stderr"]),
  /** Bytes the process wrote to this stream, as counted by the process runner itself. */
  rawByteCount: z.number().int().min(0),
  /** Raw bytes the runner actually forwarded to this consumer, or null when the runner does not report per-chunk sizes (genuinely unknown, never guessed). */
  deliveredByteCount: z.number().int().min(0).nullable(),
  /** Bytes retained after secret redaction. */
  capturedByteCount: z.number().int().min(0),
  /** Real content bytes rendered into the evidence record, excluding any omission marker. */
  includedByteCount: z.number().int().min(0),
  /** Raw bytes the runner discarded before this consumer ever saw them. */
  upstreamOmittedByteCount: z.number().int().min(0),
  /** Bytes removed by secret redaction. */
  redactionOmittedByteCount: z.number().int().min(0),
  /** Captured bytes this consumer chose not to render. */
  truncationOmittedByteCount: z.number().int().min(0),
  /** True whenever the rendered content is not the complete stream, for ANY reason. */
  captureTruncated: z.boolean(),
  truncationMethod: truncationMethodSchema,
  /**
   * SHA-256 of the COMPLETE stream this consumer held (post-redaction), so a
   * reader can always tell that what it has is not the whole thing. Null --
   * never fabricated -- whenever bytes were lost upstream, because the
   * complete content does not exist anywhere to be hashed.
   */
  fullStreamContentHash: sha256HexSchema.nullable(),
  /** SHA-256 of the exact rendered content. */
  capturedContentHash: sha256HexSchema,
  emptyOutputReason: emptyOutputReasonSchema,
  captureCompleteness: captureCompletenessSchema
}).strict().superRefine((value, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });

  if (value.deliveredByteCount !== null) {
    if (value.deliveredByteCount + value.upstreamOmittedByteCount !== value.rawByteCount) {
      fail("deliveredByteCount + upstreamOmittedByteCount must equal rawByteCount");
    }
    if (value.capturedByteCount + value.redactionOmittedByteCount !== value.deliveredByteCount) {
      fail("capturedByteCount + redactionOmittedByteCount must equal deliveredByteCount");
    }
  }
  if (value.includedByteCount + value.truncationOmittedByteCount !== value.capturedByteCount) {
    fail("includedByteCount + truncationOmittedByteCount must equal capturedByteCount");
  }

  const knownLoss = value.upstreamOmittedByteCount > 0 || value.truncationOmittedByteCount > 0;
  if (knownLoss && !value.captureTruncated) {
    fail("captureTruncated is false but bytes are reported omitted");
  }
  if (value.captureCompleteness === "COMPLETE") {
    if (knownLoss || value.captureTruncated) fail("captureCompleteness COMPLETE cannot coexist with omitted bytes or a truncated capture");
    if (value.fullStreamContentHash === null) fail("captureCompleteness COMPLETE requires the complete stream's content hash");
    if (value.truncationMethod !== "NONE") fail("captureCompleteness COMPLETE cannot declare a truncation method");
    if (value.emptyOutputReason === "LOST_UPSTREAM") fail("captureCompleteness COMPLETE cannot report lost upstream output");
  }
  if (value.captureCompleteness === "TRUNCATED_KNOWN") {
    if (value.upstreamOmittedByteCount !== 0) fail("captureCompleteness TRUNCATED_KNOWN cannot describe upstream loss, whose content is unknowable");
    if (value.truncationOmittedByteCount === 0) fail("captureCompleteness TRUNCATED_KNOWN requires omitted content bytes");
    if (value.truncationMethod === "NONE") fail("captureCompleteness TRUNCATED_KNOWN requires a truncation method");
    if (value.fullStreamContentHash === null) fail("captureCompleteness TRUNCATED_KNOWN requires the complete stream's content hash");
  }
  if (value.captureCompleteness === "TRUNCATED_UNKNOWN") {
    if (!value.captureTruncated) fail("captureCompleteness TRUNCATED_UNKNOWN requires captureTruncated");
    if (value.fullStreamContentHash !== null) fail("captureCompleteness TRUNCATED_UNKNOWN cannot carry a complete-content hash for content that was never held");
  }

  if (value.rawByteCount > 0 && value.capturedByteCount === 0 && value.emptyOutputReason !== "LOST_UPSTREAM" && value.emptyOutputReason !== "REDACTED_EMPTY") {
    fail("an empty captured stream with nonzero raw output bytes is not legitimate empty output");
  }
  if (value.emptyOutputReason === "LEGITIMATE_EMPTY" && (value.rawByteCount !== 0 || value.capturedByteCount !== 0)) {
    fail("LEGITIMATE_EMPTY requires zero raw and zero captured bytes");
  }
  if (value.emptyOutputReason === "REDACTED_EMPTY" && (value.capturedByteCount !== 0 || value.redactionOmittedByteCount === 0)) {
    fail("REDACTED_EMPTY requires an empty capture whose bytes were removed by redaction");
  }
  if (value.emptyOutputReason === "NOT_EMPTY" && value.capturedByteCount === 0) {
    fail("NOT_EMPTY requires captured content");
  }
});
export type StreamCaptureProvenance = z.infer<typeof streamCaptureProvenanceSchema>;

/** True when this stream's evidence cannot be treated as the complete output. */
export function isCaptureIncomplete(provenance: StreamCaptureProvenance): boolean {
  return provenance.captureCompleteness !== "COMPLETE";
}

/** True when this stream's loss is not even describable -- the case an AUTHORITATIVE review must refuse outright. */
export function isCaptureLossUnknown(provenance: StreamCaptureProvenance): boolean {
  return provenance.captureCompleteness === "TRUNCATED_UNKNOWN";
}

export type StreamCaptureInput = {
  stream: "stdout" | "stderr";
  /** Runner-reported bytes the process wrote to this stream. */
  rawByteCount: number;
  /** Raw bytes forwarded to this consumer, or null when the runner does not report them. */
  deliveredByteCount: number | null;
  /** True when the runner reported that it discarded output; attribution between streams may still be unknown. */
  runnerOutputTruncated: boolean;
  /** The complete redacted stream this consumer holds. */
  capturedText: string;
  /** The exact text rendered into the evidence record. */
  includedText: string;
  /** Real content bytes in `includedText`, excluding any omission marker. */
  includedContentByteCount: number;
  truncationMethod: z.infer<typeof truncationMethodSchema>;
};

/**
 * Builds a stream's provenance from measured values only.
 *
 * The one judgement call it makes is honest by construction: when the runner
 * reported discarded output but cannot say which stream lost it, this stream
 * is marked TRUNCATED_UNKNOWN with an unattributed (zero) omission count
 * rather than being credited with a completeness it cannot prove. An
 * AUTHORITATIVE review refuses TRUNCATED_UNKNOWN, so an unattributable loss
 * blocks rather than silently passing on one of the two streams.
 */
export function buildStreamCaptureProvenance(input: StreamCaptureInput): StreamCaptureProvenance {
  const capturedByteCount = utf8ByteLength(input.capturedText);
  const delivered = input.deliveredByteCount;
  const attributedUpstreamLoss = delivered === null ? 0 : Math.max(0, input.rawByteCount - delivered);
  const redactionOmittedByteCount = delivered === null ? 0 : Math.max(0, delivered - capturedByteCount);
  const truncationOmittedByteCount = Math.max(0, capturedByteCount - input.includedContentByteCount);

  // Loss is unknown when bytes were provably discarded upstream (their content
  // is gone), or when this stream cannot prove it was not the victim of a loss
  // the runner reported but could not attribute -- including a runner that
  // reports more raw bytes than this consumer can account for at all.
  const unattributable = delivered === null && (input.runnerOutputTruncated || input.rawByteCount > capturedByteCount);
  const lostUpstream = attributedUpstreamLoss > 0 || unattributable;
  const completeness: CaptureCompleteness = lostUpstream
    ? "TRUNCATED_UNKNOWN"
    : truncationOmittedByteCount > 0 ? "TRUNCATED_KNOWN" : "COMPLETE";

  const emptyOutputReason: EmptyOutputReason = capturedByteCount > 0
    ? "NOT_EMPTY"
    : lostUpstream ? "LOST_UPSTREAM"
      : redactionOmittedByteCount > 0 ? "REDACTED_EMPTY" : "LEGITIMATE_EMPTY";

  return streamCaptureProvenanceSchema.parse({
    schemaVersion: STREAM_CAPTURE_PROVENANCE_VERSION,
    stream: input.stream,
    rawByteCount: input.rawByteCount,
    deliveredByteCount: delivered,
    capturedByteCount,
    includedByteCount: input.includedContentByteCount,
    upstreamOmittedByteCount: attributedUpstreamLoss,
    redactionOmittedByteCount,
    truncationOmittedByteCount,
    captureTruncated: completeness !== "COMPLETE",
    truncationMethod: truncationOmittedByteCount > 0 ? input.truncationMethod : "NONE",
    fullStreamContentHash: lostUpstream ? null : sha256OfText(input.capturedText),
    capturedContentHash: sha256OfText(input.includedText),
    emptyOutputReason,
    captureCompleteness: completeness
  } satisfies StreamCaptureProvenance);
}
