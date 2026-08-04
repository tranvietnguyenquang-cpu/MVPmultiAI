import { z } from "zod";
import { captureCompletenessSchema } from "./stream-capture.js";
import { truncationMethodSchema } from "./review.js";
import { utf8ByteLength } from "./text-safety.js";

/**
 * The versioned contract for the execution `LOG` artifact: a newline-delimited
 * stream of JSON records, each one a complete event the execution engine
 * observed.
 *
 * Two defects this contract closes:
 *
 *  1. The producer capped the log by BYTE COUNT, writing whatever prefix of a
 *     record fit. A consumer therefore had to cope with a final line that is
 *     half a JSON object -- and a consumer that merely embedded the text as a
 *     transcript would show a reviewer a record whose meaning is a fragment of
 *     its real meaning. A record is now written whole or not at all.
 *
 *  2. Nothing validated the records. "It is NDJSON" was an assumption, so a
 *     JSON array, a bare string, a mid-line cut, or an unknown record shape
 *     all flowed straight through into the review material as if they were
 *     trustworthy structured evidence.
 *
 * `LOG_RECORD_SCHEMA_VERSION` is carried on the artifact ROW (the file is raw
 * NDJSON, with nowhere to put an envelope), exactly as the surrounding
 * `logArtifactContractSchema` already does for the artifact's own version.
 */

export const LOG_RECORD_SCHEMA_VERSION = "log-record-v1" as const;
export const LOG_PROVENANCE_SCHEMA_VERSION = "log-provenance-v1" as const;

/** One executor lifecycle event, exactly as ExecutionEngine writes it (see executorEventSchema plus engine-side redaction). */
const executorLogRecordSchema = z.object({
  type: z.enum(["process", "output", "warning", "result"]),
  message: z.string().max(1_000_000),
  payload: z.record(z.unknown())
}).strict();

/** One Relay-owned verification stream event, exactly as ExecutionEngine writes it. */
const verificationLogRecordSchema = z.object({
  type: z.literal("verification"),
  operation: z.string().min(1).max(100),
  stream: z.enum(["stdout", "stderr", "warning"]),
  message: z.string().max(1_000_000)
}).strict();

export const logRecordSchema = z.discriminatedUnion("type", [
  executorLogRecordSchema.extend({ type: z.literal("process") }),
  executorLogRecordSchema.extend({ type: z.literal("output") }),
  executorLogRecordSchema.extend({ type: z.literal("warning") }),
  executorLogRecordSchema.extend({ type: z.literal("result") }),
  verificationLogRecordSchema
]);
export type LogRecord = z.infer<typeof logRecordSchema>;

/**
 * Complete provenance for a LOG stream, carried unchanged from the producer
 * into the ReviewInputCapsule and the review material manifest.
 *
 * `fullRawContentHash` always refers to the COMPLETE producer stream -- every
 * byte offered to the log, including bytes the cap refused to store -- never
 * to the capped preview a reviewer is shown. When completeness is
 * TRUNCATED_UNKNOWN the complete stream was never held in full, and the hash
 * is null rather than fabricated from the part that survived.
 */
export const logProvenanceSchema = z.object({
  schemaVersion: z.literal(LOG_PROVENANCE_SCHEMA_VERSION),
  recordSchemaVersion: z.literal(LOG_RECORD_SCHEMA_VERSION),
  originalRawByteCount: z.number().int().min(0),
  includedRawByteCount: z.number().int().min(0),
  omittedRawByteCount: z.number().int().min(0),
  fullRawContentHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  includedContentHash: z.string().regex(/^[a-f0-9]{64}$/),
  producerTruncated: z.boolean(),
  truncationMethod: truncationMethodSchema,
  captureCompleteness: captureCompletenessSchema,
  /** Complete records the producer offered, or null when that is genuinely not knowable. */
  recordCountOriginal: z.number().int().min(0).nullable(),
  /** Complete records actually persisted. */
  recordCountIncluded: z.number().int().min(0)
}).strict().superRefine((value, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  if (value.captureCompleteness !== "TRUNCATED_UNKNOWN") {
    if (value.includedRawByteCount + value.omittedRawByteCount !== value.originalRawByteCount) {
      fail("includedRawByteCount + omittedRawByteCount must equal originalRawByteCount");
    }
    if (value.fullRawContentHash === null) fail("a log stream with known completeness must carry the complete stream's hash");
  }
  if (value.captureCompleteness === "TRUNCATED_UNKNOWN" && value.fullRawContentHash !== null) {
    fail("an UNKNOWN-completeness log stream cannot carry a hash of content that was never held in full");
  }
  if (value.producerTruncated && value.captureCompleteness === "COMPLETE") {
    fail("producerTruncated cannot be reported as COMPLETE capture");
  }
  if (value.producerTruncated && value.omittedRawByteCount === 0 && value.captureCompleteness !== "TRUNCATED_UNKNOWN") {
    fail("producerTruncated is true but no bytes are reported omitted and completeness is not UNKNOWN");
  }
  if (!value.producerTruncated && (value.omittedRawByteCount !== 0 || value.truncationMethod !== "NONE")) {
    fail("producerTruncated is false but bytes are reported omitted or a truncation method is declared");
  }
  if (value.recordCountOriginal !== null && value.recordCountOriginal < value.recordCountIncluded) {
    fail("recordCountOriginal cannot be smaller than recordCountIncluded");
  }
});
export type LogProvenance = z.infer<typeof logProvenanceSchema>;

export type LogRecordValidation =
  | { ok: true; records: LogRecord[]; recordCount: number; trailingNewlineTerminated: boolean }
  | { ok: false; reason: string };

/**
 * Validates that already strictly-decoded LOG text is complete, well-formed
 * NDJSON: every non-empty line parses as exactly one JSON OBJECT and matches
 * the versioned record schema, and the stream does not end mid-record.
 *
 * A JSON array, a bare scalar, an unknown record shape, a malformed line, or a
 * partial trailing line are all hard failures. There is deliberately no
 * "skip the bad line and carry on" mode: a log whose records cannot all be
 * accounted for is not evidence about what happened, it is evidence about
 * itself.
 */
export function validateLogRecords(text: string, label: string): LogRecordValidation {
  if (text.length === 0) return { ok: true, records: [], recordCount: 0, trailingNewlineTerminated: true };

  const trailingNewlineTerminated = text.endsWith("\n");
  if (!trailingNewlineTerminated) {
    return { ok: false, reason: `${label} does not end with a newline; its final record was cut mid-record and cannot be trusted.` };
  }

  const records: LogRecord[] = [];
  const lines = text.slice(0, -1).split("\n");
  for (const [index, line] of lines.entries()) {
    if (line.length === 0) {
      return { ok: false, reason: `${label} contains an empty line at record ${index + 1}; every line of a complete NDJSON log must be exactly one record.` };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      return { ok: false, reason: `${label} record ${index + 1} is not valid JSON; the log is malformed or was cut mid-record.` };
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return { ok: false, reason: `${label} record ${index + 1} is not a JSON object; an NDJSON log record must be exactly one object.` };
    }
    const parsed = logRecordSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, reason: `${label} record ${index + 1} failed the versioned ${LOG_RECORD_SCHEMA_VERSION} log-event schema: ${parsed.error.issues[0]?.message ?? "unknown record shape"}.` };
    }
    records.push(parsed.data);
  }
  return { ok: true, records, recordCount: records.length, trailingNewlineTerminated };
}

/**
 * The omission marker inserted when reviewer-side bounding drops records. It
 * is itself a VALID log record, so a bounded transcript is still complete,
 * parseable NDJSON -- a bare prose marker would make the very property this
 * module exists to guarantee false the moment truncation happened.
 */
export function logOmissionRecord(omittedRecordCount: number): string {
  return `${JSON.stringify({
    type: "warning",
    message: `[${omittedRecordCount} execution log record(s) omitted here by the review materializer; head and tail shown]`,
    payload: { omittedRecordCount }
  })}\n`;
}

export type BoundedLogRecords = {
  text: string;
  includedRecordCount: number;
  omittedRecordCount: number;
  /** Bytes of real records rendered, excluding the omission record. */
  includedContentByteCount: number;
  /** Bytes of the inserted omission record, charged against the budget rather than added on top of it. */
  markerByteCount: number;
};

/**
 * Bounds a validated NDJSON log to `maxBytes` on RECORD boundaries, keeping
 * the head and the tail (the tail is where a failing run's decisive events
 * are). Applied only AFTER every included record has been validated, so
 * bounding can never be what makes a log unparseable, and never renders a
 * fragment of an event.
 */
export function boundLogRecordsToBytes(text: string, maxBytes: number): BoundedLogRecords {
  const lines = text.length === 0 ? [] : text.slice(0, -1).split("\n");
  const totalBytes = utf8ByteLength(text);
  if (totalBytes <= maxBytes) {
    return { text, includedRecordCount: lines.length, omittedRecordCount: 0, includedContentByteCount: totalBytes, markerByteCount: 0 };
  }

  // Reserve the largest marker this log could need (every record omitted), so
  // the marker can never push the result back over the cap it respects.
  const markerReserve = utf8ByteLength(logOmissionRecord(lines.length));
  const contentBudget = maxBytes - markerReserve;
  if (contentBudget <= 0) {
    const marker = logOmissionRecord(lines.length);
    const markerBytes = utf8ByteLength(marker);
    return markerBytes <= maxBytes
      ? { text: marker, includedRecordCount: 0, omittedRecordCount: lines.length, includedContentByteCount: 0, markerByteCount: markerBytes }
      : { text: "", includedRecordCount: 0, omittedRecordCount: lines.length, includedContentByteCount: 0, markerByteCount: 0 };
  }

  const costs = lines.map(line => utf8ByteLength(line) + 1);
  const headBudget = Math.ceil(contentBudget / 2);
  let headCount = 0;
  let headBytes = 0;
  while (headCount < lines.length && headBytes + costs[headCount]! <= headBudget) {
    headBytes += costs[headCount]!;
    headCount += 1;
  }
  let tailCount = 0;
  let tailBytes = 0;
  while (
    headCount + tailCount < lines.length &&
    tailBytes + costs[lines.length - 1 - tailCount]! <= contentBudget - headBytes
  ) {
    tailBytes += costs[lines.length - 1 - tailCount]!;
    tailCount += 1;
  }

  const omittedRecordCount = lines.length - headCount - tailCount;
  const marker = logOmissionRecord(omittedRecordCount);
  const head = lines.slice(0, headCount).map(line => `${line}\n`).join("");
  const tail = tailCount === 0 ? "" : lines.slice(lines.length - tailCount).map(line => `${line}\n`).join("");
  return {
    text: `${head}${marker}${tail}`,
    includedRecordCount: headCount + tailCount,
    omittedRecordCount,
    includedContentByteCount: headBytes + tailBytes,
    markerByteCount: utf8ByteLength(marker)
  };
}
