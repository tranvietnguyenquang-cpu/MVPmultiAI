import { describe, expect, it } from "vitest";
import { boundLogRecordsToBytes, logProvenanceSchema, validateLogRecords, LOG_PROVENANCE_SCHEMA_VERSION, LOG_RECORD_SCHEMA_VERSION } from "./log-records.js";

/**
 * The execution LOG is structured evidence, not a blob of text. These tests
 * pin the two properties that were previously assumed rather than checked:
 * every included record is a complete, schema-valid JSON object, and the
 * provenance describing the stream cannot claim more completeness than it has.
 */

const record = (message: string, type: "output" | "warning" | "process" | "result" = "output") =>
  `${JSON.stringify({ type, message, payload: {} })}\n`;

const verificationRecord = (operation = "NPM_TEST") =>
  `${JSON.stringify({ type: "verification", operation, stream: "stdout", message: "1 passed" })}\n`;

describe("validateLogRecords", () => {
  it("accepts a complete NDJSON stream of known record types", () => {
    const result = validateLogRecords(`${record("one")}${verificationRecord()}${record("done", "result")}`, "LOG");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.recordCount).toBe(3);
  });

  it("accepts an empty log as zero records", () => {
    const result = validateLogRecords("", "LOG");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.recordCount).toBe(0);
  });

  it("rejects a partial final line, which is what a byte-level cap used to leave behind", () => {
    const result = validateLogRecords(`${record("complete")}{"type":"output","mess`, "LOG");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/cut mid-record/);
  });

  it("rejects a malformed line even when the stream ends on a newline", () => {
    const result = validateLogRecords(`${record("ok")}not json at all\n`, "LOG");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not valid JSON/);
  });

  it("rejects a JSON array where a record object belongs", () => {
    const result = validateLogRecords('[{"type":"output","message":"x","payload":{}}]\n', "LOG");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not a JSON object/);
  });

  it("rejects a bare scalar line", () => {
    expect(validateLogRecords('"just a string"\n', "LOG").ok).toBe(false);
  });

  it("rejects an unknown record shape rather than passing it through as evidence", () => {
    const result = validateLogRecords('{"event":"started"}\n', "LOG");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(new RegExp(LOG_RECORD_SCHEMA_VERSION));
  });

  it("rejects a known record type carrying an unknown extra field", () => {
    expect(validateLogRecords('{"type":"output","message":"x","payload":{},"extra":1}\n', "LOG").ok).toBe(false);
  });

  it("rejects an empty line between records", () => {
    expect(validateLogRecords(`${record("a")}\n${record("b")}`, "LOG").ok).toBe(false);
  });
});

describe("boundLogRecordsToBytes", () => {
  it("returns the whole stream untouched when it fits", () => {
    const text = `${record("a")}${record("b")}`;
    expect(boundLogRecordsToBytes(text, 10_000)).toMatchObject({ text, omittedRecordCount: 0, markerByteCount: 0 });
  });

  it("drops whole records only, keeping head and tail, and stays within the cap", () => {
    let text = "";
    for (let index = 0; index < 200; index += 1) text += record(`event ${index} ${"A".repeat(100)}`);
    const bounded = boundLogRecordsToBytes(text, 4_096);

    expect(Buffer.byteLength(bounded.text, "utf8")).toBeLessThanOrEqual(4_096);
    expect(bounded.omittedRecordCount).toBeGreaterThan(0);
    expect(bounded.includedContentByteCount + bounded.markerByteCount).toBe(Buffer.byteLength(bounded.text, "utf8"));
    // Head AND tail survive: the last events of a run are where a failure's
    // decisive evidence lives.
    expect(bounded.text).toContain("event 0 ");
    expect(bounded.text).toContain("event 199 ");
  });

  it("keeps the bounded result complete, parseable NDJSON -- the omission marker is itself a valid record", () => {
    let text = "";
    for (let index = 0; index < 100; index += 1) text += record(`event ${index} ${"B".repeat(100)}`);
    const bounded = boundLogRecordsToBytes(text, 2_048);

    const validated = validateLogRecords(bounded.text, "bounded LOG");
    expect(validated.ok).toBe(true);
    if (validated.ok) expect(validated.recordCount).toBe(bounded.includedRecordCount + 1);
    expect(bounded.text).toContain(`"omittedRecordCount":${bounded.omittedRecordCount}`);
  });
});

describe("logProvenanceSchema", () => {
  const base = {
    schemaVersion: LOG_PROVENANCE_SCHEMA_VERSION,
    recordSchemaVersion: LOG_RECORD_SCHEMA_VERSION,
    originalRawByteCount: 100, includedRawByteCount: 100, omittedRawByteCount: 0,
    fullRawContentHash: "a".repeat(64), includedContentHash: "b".repeat(64),
    producerTruncated: false, truncationMethod: "NONE" as const, captureCompleteness: "COMPLETE" as const,
    recordCountOriginal: 2, recordCountIncluded: 2
  };

  it("accepts truthful complete provenance", () => {
    expect(() => logProvenanceSchema.parse(base)).not.toThrow();
  });

  it("accepts truthful producer truncation with a complete-stream hash", () => {
    expect(() => logProvenanceSchema.parse({
      ...base, includedRawByteCount: 60, omittedRawByteCount: 40,
      producerTruncated: true, truncationMethod: "TAIL", captureCompleteness: "TRUNCATED_KNOWN",
      recordCountOriginal: 2, recordCountIncluded: 1
    })).not.toThrow();
  });

  it("refuses to call a truncated producer log COMPLETE", () => {
    expect(() => logProvenanceSchema.parse({
      ...base, producerTruncated: true, omittedRawByteCount: 40, includedRawByteCount: 60, truncationMethod: "TAIL"
    })).toThrow();
  });

  it("refuses producerTruncated with nothing reported omitted", () => {
    expect(() => logProvenanceSchema.parse({
      ...base, producerTruncated: true, truncationMethod: "TAIL", captureCompleteness: "TRUNCATED_KNOWN"
    })).toThrow();
  });

  it("refuses a byte accounting that does not add up", () => {
    expect(() => logProvenanceSchema.parse({ ...base, includedRawByteCount: 60 })).toThrow();
  });

  it("refuses a complete-stream hash for content that was never held in full", () => {
    expect(() => logProvenanceSchema.parse({ ...base, captureCompleteness: "TRUNCATED_UNKNOWN" })).toThrow();
  });

  it("requires a complete-stream hash whenever completeness is knowable", () => {
    expect(() => logProvenanceSchema.parse({ ...base, fullRawContentHash: null })).toThrow();
  });

  it("accepts an UNKNOWN stream with a null hash and a null original record count, inventing nothing", () => {
    expect(() => logProvenanceSchema.parse({
      ...base, captureCompleteness: "TRUNCATED_UNKNOWN", fullRawContentHash: null,
      recordCountOriginal: null, originalRawByteCount: 100, includedRawByteCount: 100, omittedRawByteCount: 0
    })).not.toThrow();
  });

  it("refuses to report fewer original records than included ones", () => {
    expect(() => logProvenanceSchema.parse({ ...base, recordCountOriginal: 1, recordCountIncluded: 2 })).toThrow();
  });
});
