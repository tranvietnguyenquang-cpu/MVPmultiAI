import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  canonicalJson, LOG_PROVENANCE_SCHEMA_VERSION, LOG_RECORD_SCHEMA_VERSION, logProvenanceSchema, type LogProvenance
} from "@project-relay/relay-v2-domain";
import { assertAuthoritativeLogProvenance, validateExecutionArtifact, buildEvidencePart, type ArtifactRecord } from "./artifact-evidence.js";
import { summarizeExecutionLogEvidence } from "./review-binding.js";
import { artifactRowProvenance, completeLogProvenance, logRecordLine, validatedLogPart } from "./evidence-test-fixtures.js";

/**
 * The producer's LOG provenance must reach the reviewer UNCHANGED, and must
 * describe the bytes it is attached to.
 *
 * Re-deriving provenance from the artifact row's scalar columns would quietly
 * upgrade a producer's honest "I could not prove this is complete" into a
 * claim of completeness it never made; accepting it without checking it
 * against the real bytes would let a row describe a different log than the one
 * on disk. Both directions are refused here.
 */

const SESSION_ID = "11111111-1111-1111-1111-111111111111";

describe("LOG producer provenance", () => {
  let root: string;

  beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "relay-v2-log-provenance-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  async function logArtifact(content: string, provenance: LogProvenance | null, rowOverrides: Partial<ArtifactRecord> = {}) {
    const relativePath = "log.ndjson";
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, relativePath), content, "utf8");
    const record: ArtifactRecord = {
      id: "log-id", sessionId: SESSION_ID, artifactType: "LOG", relativePath,
      sha256: createHash("sha256").update(content).digest("hex"),
      byteCount: Buffer.byteLength(content, "utf8"), truncated: false,
      ...artifactRowProvenance(content),
      provenanceJson: provenance ? canonicalJson(provenance) : "{}",
      ...rowOverrides
    };
    const validated = await validateExecutionArtifact(root, SESSION_ID, new Set([record.id]), record);
    expect(validated.ok).toBe(true);
    if (!validated.ok) throw new Error(validated.reason);
    return buildEvidencePart(record, validated.content, "LOG");
  }

  it("accepts a complete log and carries its provenance through verbatim", async () => {
    const content = `${logRecordLine("one")}${logRecordLine("two")}`;
    const provenance = completeLogProvenance(content);
    const part = await logArtifact(content, provenance);

    expect(part.ok).toBe(true);
    if (!part.ok) return;
    // Verbatim: the object the reviewer holds is the object the producer
    // wrote, not a reconstruction that happens to agree with it today.
    expect(part.part.logProvenance).toEqual(provenance);
    expect(part.part.logProvenance?.captureCompleteness).toBe("COMPLETE");
  });

  it("accepts a capped log whose provenance states the complete hash and the omitted byte count", async () => {
    const stored = logRecordLine("kept");
    const complete = `${stored}${logRecordLine("dropped by the cap")}`;
    const provenance: LogProvenance = {
      schemaVersion: LOG_PROVENANCE_SCHEMA_VERSION, recordSchemaVersion: LOG_RECORD_SCHEMA_VERSION,
      originalRawByteCount: Buffer.byteLength(complete, "utf8"),
      includedRawByteCount: Buffer.byteLength(stored, "utf8"),
      omittedRawByteCount: Buffer.byteLength(complete, "utf8") - Buffer.byteLength(stored, "utf8"),
      // The COMPLETE producer stream's hash -- not the capped preview's.
      fullRawContentHash: createHash("sha256").update(complete).digest("hex"),
      includedContentHash: createHash("sha256").update(stored).digest("hex"),
      producerTruncated: true, truncationMethod: "TAIL", captureCompleteness: "TRUNCATED_KNOWN",
      recordCountOriginal: 2, recordCountIncluded: 1
    };
    const part = await logArtifact(stored, provenance, {
      truncated: true,
      fullContentSha256: provenance.fullRawContentHash!,
      originalByteCount: provenance.originalRawByteCount,
      omittedByteCount: provenance.omittedRawByteCount,
      truncationMethod: "TAIL"
    });

    expect(part.ok).toBe(true);
    if (!part.ok) return;
    expect(part.part.logProvenance?.fullRawContentHash).not.toBe(part.part.rawBytesHash);
    expect(part.part.producerTruncated).toBe(true);
  });

  it("rejects provenance whose included-content hash does not describe these bytes", async () => {
    const content = logRecordLine("real");
    const part = await logArtifact(content, { ...completeLogProvenance(content), includedContentHash: "0".repeat(64) });
    expect(part.ok).toBe(false);
    if (!part.ok) expect(part.reason).toMatch(/includedContentHash is not the hash of the exact validated included bytes/);
  });

  it("rejects provenance whose included byte count does not match the bytes it is attached to", async () => {
    const content = logRecordLine("real");
    const provenance = completeLogProvenance(content);
    const part = await logArtifact(content, {
      ...provenance,
      originalRawByteCount: provenance.originalRawByteCount + 10,
      includedRawByteCount: provenance.includedRawByteCount + 10
    });
    expect(part.ok).toBe(false);
    if (!part.ok) expect(part.reason).toMatch(/includedRawByteCount \d+ vs \d+ validated byte\(s\)/);
  });

  it("rejects a row that claims truncation while reporting nothing omitted, before its provenance is even consulted", async () => {
    const content = logRecordLine("real");
    const part = await logArtifact(content, completeLogProvenance(content), { truncated: true });
    expect(part.ok).toBe(false);
    // The versioned row contract refuses "truncated, but nothing was lost"
    // outright, so the disagreement never has to be resolved downstream.
    if (!part.ok) expect(part.reason).toMatch(/LOG text-artifact contract/);
  });

  it("rejects provenance that claims completeness while its own row records omitted bytes", async () => {
    const content = logRecordLine("real");
    const part = await logArtifact(content, completeLogProvenance(content), {
      truncated: true, omittedByteCount: 40, originalByteCount: Buffer.byteLength(content, "utf8") + 40, truncationMethod: "TAIL"
    });
    expect(part.ok).toBe(false);
    if (!part.ok) expect(part.reason).toMatch(/originalRawByteCount \d+ vs row originalByteCount \d+/);
  });

  it("rejects provenance whose included record count disagrees with the records actually present", async () => {
    const content = `${logRecordLine("one")}${logRecordLine("two")}`;
    const part = await logArtifact(content, { ...completeLogProvenance(content), recordCountIncluded: 1, recordCountOriginal: 2 });
    expect(part.ok).toBe(false);
    if (!part.ok) expect(part.reason).toMatch(/recordCountIncluded \d+ vs \d+ validated NDJSON record\(s\)/);
  });

  it("rejects a log whose final record was cut mid-record", async () => {
    const part = await logArtifact(`${logRecordLine("complete")}{"type":"output","mess`, null);
    expect(part.ok).toBe(false);
    if (!part.ok) expect(part.reason).toMatch(/cut mid-record/);
  });

  it("rejects a log line that is a JSON array rather than one record object", async () => {
    const part = await logArtifact('[{"type":"output","message":"x","payload":{}}]\n', null);
    expect(part.ok).toBe(false);
    if (!part.ok) expect(part.reason).toMatch(/not a JSON object/);
  });

  it("rejects an unrecognized record shape rather than embedding it as a transcript", async () => {
    const part = await logArtifact('{"event":"started"}\n', null);
    expect(part.ok).toBe(false);
    if (!part.ok) expect(part.reason).toMatch(new RegExp(LOG_RECORD_SCHEMA_VERSION));
  });

  it("carries the producer's provenance into the rendered execution-log evidence unchanged", async () => {
    const content = `${logRecordLine("one")}${logRecordLine("two")}`;
    const provenance = completeLogProvenance(content);
    // Rendered from the SAME validated part artifact validation produced --
    // the exact hand-off where the provenance used to be dropped.
    const part = await logArtifact(content, provenance);
    expect(part.ok).toBe(true);
    if (!part.ok || !part.log) throw new Error("expected a validated LOG evidence part");
    const summary = summarizeExecutionLogEvidence(part.log);

    expect(summary.ok).toBe(true);
    if (!summary.ok) return;
    expect(summary.evidence.producerProvenance).toEqual(provenance);
    expect(summary.evidence.reviewerIncludedRecordCount).toBe(2);
    expect(summary.evidence.reviewerOmittedRecordCount).toBe(0);
  });

  it("never renders a producer-truncated log as complete", () => {
    const content = logRecordLine("only what survived");
    const provenance: LogProvenance = {
      ...completeLogProvenance(content),
      originalRawByteCount: Buffer.byteLength(content, "utf8") + 500,
      omittedRawByteCount: 500,
      producerTruncated: true, truncationMethod: "TAIL", captureCompleteness: "TRUNCATED_KNOWN",
      recordCountOriginal: 9, recordCountIncluded: 1
    };
    const summary = summarizeExecutionLogEvidence(validatedLogPart(content, {
      provenance, producerTruncated: true, producerOmittedByteCount: 500, producerTruncationMethod: "TAIL"
    }));

    expect(summary.ok).toBe(true);
    if (!summary.ok) return;
    expect(summary.evidence.producerTruncated).toBe(true);
    expect(summary.evidence.anyTruncation).toBe(true);
    expect(summary.evidence.producerProvenance?.captureCompleteness).toBe("TRUNCATED_KNOWN");
    expect(summary.evidence.producerProvenance?.recordCountOriginal).toBe(9);
  });

  /**
   * The AUTHORITATIVE gate, checked against the real validated part. Each case
   * below is a log a producer might genuinely hand over; none of them may
   * authorize a Claude process, because none of them can say what the complete
   * stream was.
   */
  /**
   * The artifact row and the producer provenance are two records of ONE log.
   * Each was previously only ever checked against itself, so both could be
   * internally valid while describing different streams -- a row reporting 999
   * omitted bytes cut HEAD_AND_TAIL alongside provenance reporting 1 omitted
   * byte cut TAIL. Neither account may be preferred, inferred from, or
   * normalized into the other; the pair is refused.
   */
  describe("artifact row versus producer provenance", () => {
    const content = `${logRecordLine("one")}${logRecordLine("two")}`;
    const includedByteCount = Buffer.byteLength(content, "utf8");
    const includedHash = createHash("sha256").update(content).digest("hex");
    const fullStreamHash = createHash("sha256").update(`${content}dropped`).digest("hex");

    /** A row and a provenance that agree exactly: truthfully truncated, same counts, same method, same hashes. */
    function agreeingTruncated(omitted: number, method: "TAIL" | "HEAD_AND_TAIL" = "TAIL") {
      const provenance: LogProvenance = {
        ...completeLogProvenance(content),
        originalRawByteCount: includedByteCount + omitted,
        includedRawByteCount: includedByteCount,
        omittedRawByteCount: omitted,
        fullRawContentHash: fullStreamHash,
        includedContentHash: includedHash,
        producerTruncated: true, truncationMethod: method, captureCompleteness: "TRUNCATED_KNOWN",
        recordCountOriginal: 5, recordCountIncluded: 2
      };
      const row: Partial<ArtifactRecord> = {
        truncated: true, originalByteCount: includedByteCount + omitted, omittedByteCount: omitted,
        truncationMethod: method, fullContentSha256: fullStreamHash
      };
      return { provenance, row };
    }

    it("rejects the exact adversarial pair: row says 999 omitted bytes cut HEAD_AND_TAIL, provenance says 1 cut TAIL", async () => {
      const { row } = agreeingTruncated(999, "HEAD_AND_TAIL");
      const { provenance } = agreeingTruncated(1, "TAIL");
      // Each record is internally valid on its own terms; only comparing them
      // reveals that they cannot both describe the same producer stream.
      expect(() => logProvenanceSchema.parse(provenance)).not.toThrow();

      const part = await logArtifact(content, provenance, row);
      expect(part.ok).toBe(false);
      if (part.ok) return;
      expect(part.code).toBe("LOG_PROVENANCE_ARTIFACT_MISMATCH");
      expect(part.reason).toMatch(/describe different log streams/);
      expect(part.reason).toMatch(/originalRawByteCount \d+ vs row originalByteCount \d+/);
      // No path and no log content ever appear in the refusal.
      expect(part.reason).not.toMatch(/log\.ndjson|one|two/);
    });

    /** Each case breaks exactly ONE overlapping field, leaving every other field in agreement. */
    const focusedMismatches: ReadonlyArray<readonly [string, () => { provenance: LogProvenance; row: Partial<ArtifactRecord> }, RegExp]> = [
      ["original byte count", () => {
        const base = agreeingTruncated(64);
        return { provenance: { ...base.provenance }, row: { ...base.row, originalByteCount: includedByteCount + 65, omittedByteCount: 65 } };
      }, /originalRawByteCount \d+ vs row originalByteCount \d+/],
      ["included byte count", () => {
        const base = agreeingTruncated(64);
        return {
          provenance: { ...base.provenance, includedRawByteCount: includedByteCount - 1, originalRawByteCount: includedByteCount + 63 },
          row: base.row
        };
      }, /includedRawByteCount \d+ vs \d+ validated byte\(s\)/],
      ["omitted byte count", () => {
        const base = agreeingTruncated(64);
        return {
          provenance: { ...base.provenance, omittedRawByteCount: 32, originalRawByteCount: includedByteCount + 32 },
          row: base.row
        };
      }, /originalRawByteCount \d+ vs row originalByteCount \d+/],
      ["truncation method", () => {
        const base = agreeingTruncated(64, "TAIL");
        return { provenance: base.provenance, row: { ...base.row, truncationMethod: "HEAD_AND_TAIL" } };
      }, /truncationMethod TAIL vs row truncationMethod HEAD_AND_TAIL/],
      ["included-content hash", () => {
        const base = agreeingTruncated(64);
        return { provenance: { ...base.provenance, includedContentHash: "0".repeat(64) }, row: base.row };
      }, /includedContentHash is not the hash of the exact validated included bytes/],
      ["included record count", () => {
        const base = agreeingTruncated(64);
        return { provenance: { ...base.provenance, recordCountIncluded: 1 }, row: base.row };
      }, /recordCountIncluded \d+ vs \d+ validated NDJSON record\(s\)/]
    ];

    it.each(focusedMismatches)("rejects a pair that disagrees on the %s alone", async (_label, build, expected) => {
      const { provenance, row } = build();
      const part = await logArtifact(content, provenance, row);
      expect(part.ok).toBe(false);
      if (part.ok) return;
      expect(part.code).toBe("LOG_PROVENANCE_ARTIFACT_MISMATCH");
      expect(part.reason).toMatch(expected);
    });

    it("rejects a pair that disagrees on producerTruncated alone", async () => {
      // The row records a complete, untruncated capture; the provenance claims
      // the producer cut the stream. Both are internally valid.
      const provenance: LogProvenance = {
        ...completeLogProvenance(content),
        originalRawByteCount: includedByteCount + 64, omittedRawByteCount: 64,
        fullRawContentHash: fullStreamHash, producerTruncated: true,
        truncationMethod: "NONE", captureCompleteness: "TRUNCATED_KNOWN", recordCountOriginal: 5
      };
      const part = await logArtifact(content, provenance);
      expect(part.ok).toBe(false);
      if (part.ok) return;
      expect(part.code).toBe("LOG_PROVENANCE_ARTIFACT_MISMATCH");
      expect(part.reason).toMatch(/originalRawByteCount \d+ vs row originalByteCount \d+|producerTruncated true vs row truncated false/);
    });

    it("rejects a row whose own byte arithmetic does not describe the bytes it points at", async () => {
      const base = agreeingTruncated(64);
      // original - omitted no longer equals the real file size: the row is not
      // describing the artifact it names, whatever the provenance says.
      const part = await logArtifact(content, base.provenance, { ...base.row, omittedByteCount: 32, truncationMethod: "TAIL" });
      expect(part.ok).toBe(false);
      if (part.ok) return;
      expect(part.code).toBe("LOG_PROVENANCE_ARTIFACT_MISMATCH");
    });

    it("accepts a complete, untruncated row and provenance that agree", async () => {
      const part = await logArtifact(content, completeLogProvenance(content));
      expect(part.ok).toBe(true);
      if (!part.ok) return;
      expect(assertAuthoritativeLogProvenance(part.log ?? null)).toEqual({ ok: true });
    });

    it("accepts a truthfully truncated row and provenance that agree", async () => {
      const { provenance, row } = agreeingTruncated(999, "HEAD_AND_TAIL");
      const part = await logArtifact(content, provenance, row);
      expect(part.ok).toBe(true);
      if (!part.ok) return;
      expect(part.log?.logProvenance).toEqual(provenance);
      expect(assertAuthoritativeLogProvenance(part.log ?? null)).toEqual({ ok: true });
    });

    it("does not let reviewer-side rendering of an agreeing pair overwrite the producer's provenance", async () => {
      const { provenance, row } = agreeingTruncated(999, "HEAD_AND_TAIL");
      const part = await logArtifact(content, provenance, row);
      expect(part.ok).toBe(true);
      if (!part.ok || !part.log) throw new Error("expected a validated LOG evidence part");
      const summary = summarizeExecutionLogEvidence(part.log);
      expect(summary.ok).toBe(true);
      if (!summary.ok) return;
      // Producer: 999 bytes lost, HEAD_AND_TAIL. Reviewer: rendered everything
      // it was handed. Both stated, neither overwritten.
      expect(summary.evidence.producerProvenance).toEqual(provenance);
      expect(summary.evidence.producerProvenance?.truncationMethod).toBe("HEAD_AND_TAIL");
      expect(summary.evidence.producerTruncated).toBe(true);
      expect(summary.evidence.reviewerTruncated).toBe(false);
      expect(summary.evidence.reviewerTruncationMethod).toBe("NONE");
      expect(summary.evidence.reviewerOmittedByteCount).toBe(0);
      expect(summary.evidence.sourceByteCount).toBe(includedByteCount);
      expect(summary.evidence.anyTruncation).toBe(true);
    });
  });

  describe("authoritative provenance requirements", () => {
    it("accepts a complete, self-describing log", async () => {
      const content = `${logRecordLine("one")}${logRecordLine("two")}`;
      const part = await logArtifact(content, completeLogProvenance(content));
      expect(part.ok).toBe(true);
      if (!part.ok) return;
      expect(assertAuthoritativeLogProvenance(part.log ?? null)).toEqual({ ok: true });
    });

    it("refuses a session with no LOG evidence at all", () => {
      const refusal = assertAuthoritativeLogProvenance(null);
      expect(refusal.ok).toBe(false);
      if (!refusal.ok) expect(refusal.reason).toMatch(/No execution LOG evidence/);
    });

    it("refuses absent provenance ('{}' on the row)", async () => {
      const content = logRecordLine("no provenance");
      const part = await logArtifact(content, null);
      expect(part.ok).toBe(true);
      if (!part.ok) return;
      expect(part.log?.logProvenance).toBeNull();
      const refusal = assertAuthoritativeLogProvenance(part.log ?? null);
      expect(refusal.ok).toBe(false);
      if (!refusal.ok) expect(refusal.reason).toMatch(/carries no producer provenance/);
    });

    it("refuses TRUNCATED_UNKNOWN completeness -- the producer cannot say what was lost", () => {
      const content = logRecordLine("what survived");
      const unknown = validatedLogPart(content, {
        provenance: {
          ...completeLogProvenance(content),
          fullRawContentHash: null, captureCompleteness: "TRUNCATED_UNKNOWN", recordCountOriginal: null
        }
      });
      const refusal = assertAuthoritativeLogProvenance(unknown);
      expect(refusal.ok).toBe(false);
      if (!refusal.ok) expect(refusal.reason).toMatch(/UNKNOWN capture completeness/);
    });

    it("refuses producerTruncated=true with nothing reported omitted", () => {
      const content = logRecordLine("claims truncation");
      const refusal = assertAuthoritativeLogProvenance(validatedLogPart(content, {
        provenance: {
          ...completeLogProvenance(content),
          producerTruncated: true, truncationMethod: "TAIL", captureCompleteness: "TRUNCATED_KNOWN",
          omittedRawByteCount: 0
        },
        // The ROW agrees with the provenance in every other field, so the only
        // thing left to refuse is the untruthful omitted-byte claim itself.
        producerTruncated: true, producerTruncationMethod: "TAIL", producerOmittedByteCount: 0
      }));
      expect(refusal.ok).toBe(false);
      if (!refusal.ok) expect(refusal.reason).toMatch(/without truthful omitted-byte provenance/);
    });

    it("refuses an included-content hash that does not match the validated bytes", () => {
      const content = logRecordLine("real");
      const refusal = assertAuthoritativeLogProvenance(validatedLogPart(content, {
        provenance: { ...completeLogProvenance(content), includedContentHash: "0".repeat(64) }
      }));
      expect(refusal.ok).toBe(false);
      if (!refusal.ok) expect(refusal.reason).toMatch(/included-content hash/);
    });

    it("refuses raw byte counts that do not add up", () => {
      const content = logRecordLine("real");
      const complete = completeLogProvenance(content);
      const refusal = assertAuthoritativeLogProvenance(validatedLogPart(content, {
        provenance: { ...complete, originalRawByteCount: complete.includedRawByteCount + 64 }
      }));
      expect(refusal.ok).toBe(false);
      if (!refusal.ok) expect(refusal.reason).toMatch(/do not add up/);
    });

    it("refuses a record count that disagrees with the validated records", () => {
      const content = `${logRecordLine("one")}${logRecordLine("two")}`;
      const refusal = assertAuthoritativeLogProvenance(validatedLogPart(content, {
        provenance: { ...completeLogProvenance(content), recordCountIncluded: 5, recordCountOriginal: 5 }
      }));
      expect(refusal.ok).toBe(false);
      if (!refusal.ok) expect(refusal.reason).toMatch(/included record\(s\) but validates to 2/);
    });

    it("refuses provenance that disagrees with its own artifact row about truncation", () => {
      const content = logRecordLine("real");
      const refusal = assertAuthoritativeLogProvenance(validatedLogPart(content, {
        provenance: completeLogProvenance(content), producerTruncated: true
      }));
      expect(refusal.ok).toBe(false);
      if (!refusal.ok) expect(refusal.reason).toMatch(/disagrees with its own artifact row/);
    });

    it("refuses a complete log whose original record count exceeds what it included", () => {
      const content = logRecordLine("real");
      const refusal = assertAuthoritativeLogProvenance(validatedLogPart(content, {
        provenance: { ...completeLogProvenance(content), recordCountOriginal: 4 }
      }));
      expect(refusal.ok).toBe(false);
      if (!refusal.ok) expect(refusal.reason).toMatch(/original and included record counts differ/);
    });

    for (const [label, content] of [
      ["a malformed NDJSON record", '{"type":"output","message":"x"\n'],
      ["a partial trailing line", `${logRecordLine("complete")}{"type":"output","mess`]
    ] as const) {
      it(`refuses ${label} before provenance is ever consulted`, async () => {
        const part = await logArtifact(content, null);
        expect(part.ok).toBe(false);
      });
    }
  });
});
