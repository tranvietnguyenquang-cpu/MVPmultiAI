import { createHash, randomUUID, type Hash } from "node:crypto";
import { appendFile, mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  canonicalJson, EVIDENCE_ARTIFACT_SCHEMA_VERSION, LOG_PROVENANCE_SCHEMA_VERSION, LOG_RECORD_SCHEMA_VERSION,
  logProvenanceSchema, sha256OfBytes, untruncatedProvenance,
  type LogProvenance, type ProducerTruncation, type TruncationMethod
} from "@project-relay/relay-v2-domain";
import { redactSecrets } from "@project-relay/local-safety";

/**
 * Everything persisted about one execution artifact's bytes.
 *
 * `sha256`/`byteCount` describe what is ACTUALLY on disk. The provenance
 * fields describe what existed before any truncation:
 * `fullContentSha256` is the hash of the complete content and
 * `originalByteCount` its size, so a consumer can always tell that what it
 * holds is not the whole thing -- even when the whole thing no longer exists
 * anywhere. When nothing was lost the two hashes are equal and
 * `omittedByteCount` is 0.
 *
 * `originalByteCount` is never back-inferred from the already-truncated file:
 * every writer below computes it from the complete content it held before
 * writing, or (for the append-only log) accumulates it as bytes are offered.
 */
export type ArtifactMetadata = {
  artifactType: "LOG" | "CHANGED_FILES" | "CAPSULE" | "BASELINE_GIT" | "FINAL_GIT" | "PATCH" | "VERIFICATION";
  relativePath: string;
  sha256: string;
  byteCount: number;
  truncated: boolean;
  /** The versioned evidence-artifact contract this artifact's content conforms to; empty for artifact types with no versioned contract (CAPSULE, BASELINE_GIT). */
  schemaVersion: string;
  fullContentSha256: string;
  originalByteCount: number;
  omittedByteCount: number;
  truncationMethod: TruncationMethod;
  /**
   * The producer's own versioned provenance object, canonicalized. Carried
   * through to the reviewer UNCHANGED -- a consumer re-derives nothing from
   * the row's scalar columns that this object already states, so a producer's
   * honest "I could not prove this is complete" can never be lost in
   * translation and re-emerge downstream as a confident claim of completeness.
   * `{}` for artifact types with no additional provenance beyond the columns.
   */
  provenanceJson: string;
};

/** Complete (newline-terminated) records in a raw NDJSON buffer; a trailing fragment is never counted as a record. */
function countCompleteRecords(contents: Buffer): number {
  let count = 0;
  for (let index = 0; index < contents.byteLength; index += 1) if (contents[index] === 0x0a) count += 1;
  return count;
}

/**
 * Running provenance for one session's append-only log, so the complete size,
 * hash, and RECORD COUNT survive the byte cap that discards content.
 * `includedRecordCount` counts only records written whole -- the cap never
 * stores a fragment of one.
 */
type LogAccumulator = {
  originalByteCount: number;
  hash: Hash;
  omittedByteCount: number;
  originalRecordCount: number;
  includedRecordCount: number;
};

export class ExecutionArtifactStore {
  /**
   * Keyed by session id. Tracks every byte OFFERED to the log, including
   * bytes the cap refused to store, so `finalizeLog` can report the complete
   * original size and hash rather than describing the truncated file as if it
   * were whole.
   */
  private readonly logAccumulators = new Map<string, LogAccumulator>();

  constructor(readonly artifactsRoot: string, readonly maxLogBytes = 5 * 1024 * 1024) {}

  private sessionDirectory(sessionId: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(sessionId)) throw new Error("Invalid execution session ID for artifact storage.");
    return path.join(this.artifactsRoot, "executions", sessionId);
  }

  private relative(absolutePath: string): string {
    return path.relative(this.artifactsRoot, absolutePath).replace(/\\/g, "/");
  }

  artifactDirectory(sessionId: string): string {
    return this.relative(this.sessionDirectory(sessionId));
  }

  private accumulator(sessionId: string): LogAccumulator {
    let existing = this.logAccumulators.get(sessionId);
    if (!existing) {
      existing = { originalByteCount: 0, hash: createHash("sha256"), omittedByteCount: 0, originalRecordCount: 0, includedRecordCount: 0 };
      this.logAccumulators.set(sessionId, existing);
    }
    return existing;
  }

  async initializeLog(sessionId: string): Promise<void> {
    const directory = this.sessionDirectory(sessionId);
    await mkdir(directory, { recursive: true });
    const handle = await open(path.join(directory, "output.ndjson"), "wx").catch(error => {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
      throw error;
    });
    await handle?.close();
  }

  /**
   * Appends one COMPLETE NDJSON record, or none at all.
   *
   * The byte cap used to write whatever prefix of a record happened to fit,
   * leaving a final line that is half a JSON object. Every consumer then had
   * to either reject the whole log or -- worse, and what actually happened --
   * embed the fragment as if it were a transcript, showing a reviewer a record
   * whose meaning is a truncated version of its real meaning. A record is now
   * atomic: it fits and is written whole, or it is omitted whole and counted
   * as omitted. The file therefore always ends on a record boundary.
   */
  async appendLog(sessionId: string, value: unknown): Promise<boolean> {
    await this.initializeLog(sessionId);
    const file = path.join(this.sessionDirectory(sessionId), "output.ndjson");
    const current = (await stat(file)).size;
    const line = Buffer.from(`${redactSecrets(JSON.stringify(value))}\n`, "utf8");
    // Account for the complete line BEFORE deciding whether it fits.
    const accumulator = this.accumulator(sessionId);
    accumulator.originalByteCount += line.byteLength;
    accumulator.originalRecordCount += 1;
    accumulator.hash.update(line);
    const remaining = Math.max(0, this.maxLogBytes - current);
    const fits = line.byteLength <= remaining;
    if (fits) {
      await appendFile(file, line);
      accumulator.includedRecordCount += 1;
      return false;
    }
    accumulator.omittedByteCount += line.byteLength;
    return true;
  }

  /**
   * Finalizes the log artifact with truthful, versioned provenance.
   *
   * With the running accumulator (the normal in-process case) every count and
   * both hashes describe the COMPLETE producer stream -- every byte and every
   * record offered to the log, including those the cap refused -- never the
   * capped file dressed up as the whole thing. `truncationMethod` is TAIL
   * because the cap drops the LAST records that no longer fit, not the first.
   *
   * Without an accumulator -- only possible if the store was reconstructed
   * mid-session -- the complete stream was never held, so completeness is
   * reported as TRUNCATED_UNKNOWN with a null hash and a null original record
   * count. Nothing is invented to fill those in.
   */
  async finalizeLog(sessionId: string, truncated = false): Promise<ArtifactMetadata> {
    await this.initializeLog(sessionId);
    const file = path.join(this.sessionDirectory(sessionId), "output.ndjson");
    const contents = await readFile(file);
    const accumulator = this.logAccumulators.get(sessionId);
    this.logAccumulators.delete(sessionId);
    const storedSha256 = sha256OfBytes(contents);
    const producerTruncated = accumulator ? accumulator.omittedByteCount > 0 : truncated;
    const knownComplete = accumulator !== undefined;
    const provenance: LogProvenance = logProvenanceSchema.parse({
      schemaVersion: LOG_PROVENANCE_SCHEMA_VERSION,
      recordSchemaVersion: LOG_RECORD_SCHEMA_VERSION,
      originalRawByteCount: accumulator ? accumulator.originalByteCount : contents.byteLength,
      includedRawByteCount: contents.byteLength,
      omittedRawByteCount: accumulator ? accumulator.omittedByteCount : 0,
      fullRawContentHash: knownComplete ? accumulator.hash.copy().digest("hex") : null,
      includedContentHash: storedSha256,
      producerTruncated,
      truncationMethod: producerTruncated && knownComplete ? "TAIL" : "NONE",
      captureCompleteness: !knownComplete ? "TRUNCATED_UNKNOWN" : producerTruncated ? "TRUNCATED_KNOWN" : "COMPLETE",
      recordCountOriginal: accumulator ? accumulator.originalRecordCount : null,
      recordCountIncluded: accumulator ? accumulator.includedRecordCount : countCompleteRecords(contents)
    } satisfies LogProvenance);
    return {
      artifactType: "LOG",
      relativePath: this.relative(file),
      sha256: storedSha256,
      byteCount: contents.byteLength,
      truncated: producerTruncated || truncated,
      schemaVersion: EVIDENCE_ARTIFACT_SCHEMA_VERSION,
      fullContentSha256: knownComplete ? accumulator.hash.copy().digest("hex") : storedSha256,
      originalByteCount: accumulator ? accumulator.originalByteCount : contents.byteLength,
      omittedByteCount: accumulator ? accumulator.omittedByteCount : 0,
      truncationMethod: producerTruncated && knownComplete ? "TAIL" : "NONE",
      provenanceJson: canonicalJson(provenance)
    };
  }

  /**
   * Writes one structured, versioned evidence artifact.
   *
   * Structured evidence is never byte-truncated: a truncated JSON document
   * does not parse, so cutting it would replace usable evidence with
   * unusable bytes while still occupying the artifact slot. Oversized content
   * is refused outright by the caller's own limits and by the reviewer's
   * per-artifact size check on read. Producer truncation that genuinely did
   * occur is carried INSIDE the envelope, on the specific field it affected
   * (a truncated patch, a truncated verification stream), where it can be
   * reported exactly.
   */
  async writeArtifact(
    sessionId: string,
    artifactType: Exclude<ArtifactMetadata["artifactType"], "LOG">,
    filename: string,
    value: unknown,
    options: { schemaVersion?: string; innerTruncation?: ProducerTruncation } = {}
  ): Promise<ArtifactMetadata> {
    if (!/^[a-z0-9][a-z0-9.-]{0,100}$/i.test(filename)) throw new Error("Invalid execution artifact filename.");
    const directory = this.sessionDirectory(sessionId);
    await mkdir(directory, { recursive: true });
    const target = path.join(directory, filename);
    const temporary = path.join(directory, `.${filename}-${randomUUID()}.tmp`);
    const serialized = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    const contents = Buffer.from(`${redactSecrets(serialized)}\n`, "utf8");
    await writeFile(temporary, contents, { flag: "wx" });
    await rename(temporary, target);
    const sha256 = sha256OfBytes(contents);
    // The envelope file itself is always whole. Any loss reported here comes
    // from content the producer could not capture in full BEFORE it was
    // serialized into this envelope.
    const inner = options.innerTruncation ?? untruncatedProvenance("");
    const lostInside = inner.producerTruncated || inner.captureTruncated;
    return {
      artifactType,
      relativePath: this.relative(target),
      sha256,
      byteCount: contents.byteLength,
      truncated: lostInside,
      schemaVersion: options.schemaVersion ?? "",
      fullContentSha256: sha256,
      originalByteCount: contents.byteLength,
      omittedByteCount: inner.omittedByteCount,
      truncationMethod: inner.truncationMethod,
      provenanceJson: "{}"
    };
  }
}
