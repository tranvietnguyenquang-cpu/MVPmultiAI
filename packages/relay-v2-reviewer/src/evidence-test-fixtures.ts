import { createHash } from "node:crypto";
import {
  buildStreamCaptureProvenance, canonicalJson, EVIDENCE_ARTIFACT_SCHEMA_VERSION, LOG_PROVENANCE_SCHEMA_VERSION,
  LOG_RECORD_SCHEMA_VERSION, logProvenanceSchema, sha256OfText, untruncatedProvenance, validateLogRecords,
  type ChangedFileEntry, type ChangedFilesArtifact, type FinalGitArtifact, type LogProvenance, type PatchArtifact,
  type ProducerTruncation, type StreamCaptureProvenance, type VerificationArtifact
} from "@project-relay/relay-v2-domain";
import type { ArtifactRecord, ValidatedLogEvidencePart } from "./artifact-evidence.js";

/**
 * Canonical, schema-valid evidence-artifact fixtures shared by the reviewer
 * tests. Kept in one place so a test proving a REJECTION is always rejecting
 * for the reason it names, rather than incidentally failing an unrelated
 * schema check because a hand-written literal drifted from the contract.
 */

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);

export function changedFile(path: string, overrides: Partial<ChangedFileEntry> = {}): ChangedFileEntry {
  return { path, status: "modified", renamedFrom: null, binary: false, baselineSha256: "1".repeat(64), finalSha256: "2".repeat(64), ...overrides };
}

export function finalGitArtifact(changedFiles: readonly ChangedFileEntry[] = [], overrides: Partial<FinalGitArtifact> = {}): FinalGitArtifact {
  return {
    schemaVersion: EVIDENCE_ARTIFACT_SCHEMA_VERSION,
    artifactType: "FINAL_GIT",
    branch: "relay-v2",
    head: HEAD_B,
    clean: changedFiles.length === 0,
    changedFileCount: changedFiles.length,
    changedFiles: [...changedFiles],
    fullEvidenceHash: "3".repeat(64),
    captureEvidenceHash: "4".repeat(64),
    capturedAt: "2026-08-05T00:00:00.000Z",
    forbiddenGitMutationSuspected: false,
    truncation: untruncatedProvenance(""),
    ...overrides
  };
}

export function patchArtifact(coveredPaths: readonly string[] = [], overrides: Partial<PatchArtifact> = {}): PatchArtifact {
  const unifiedDiff = coveredPaths.map(path => `diff --git a/${path} b/${path}\n`).join("");
  return {
    schemaVersion: EVIDENCE_ARTIFACT_SCHEMA_VERSION,
    artifactType: "PATCH",
    patchKind: "FINAL",
    baselineHead: HEAD_A,
    finalHead: HEAD_B,
    unifiedDiff,
    coveredPaths: [...coveredPaths],
    omittedPaths: [],
    fullContentHash: sha256OfText(unifiedDiff),
    truncation: untruncatedProvenance(unifiedDiff),
    ...overrides
  };
}

export function changedFilesArtifact(files: readonly ChangedFileEntry[] = [], overrides: Partial<ChangedFilesArtifact> = {}): ChangedFilesArtifact {
  const sorted = [...files].sort((left, right) => left.path.localeCompare(right.path));
  return {
    schemaVersion: EVIDENCE_ARTIFACT_SCHEMA_VERSION,
    artifactType: "CHANGED_FILES",
    files: sorted,
    fileCount: sorted.length,
    manifestHash: sha256OfText(canonicalJson(sorted)),
    truncation: untruncatedProvenance(""),
    ...overrides
  };
}

export function verificationArtifact(results: VerificationArtifact["results"] = [], overrides: Partial<VerificationArtifact> = {}): VerificationArtifact {
  return {
    schemaVersion: EVIDENCE_ARTIFACT_SCHEMA_VERSION,
    artifactType: "VERIFICATION",
    results,
    fullContentHash: sha256OfText(canonicalJson(results)),
    truncation: untruncatedProvenance(""),
    ...overrides
  };
}

/** Producer provenance describing content that was truncated by the execution writer. */
export function truncatedProducerProvenance(originalByteCount = 200, includedByteCount = 120): ProducerTruncation {
  return {
    producerTruncated: true, captureTruncated: false, originalByteCount, includedByteCount,
    omittedByteCount: originalByteCount - includedByteCount, truncationMethod: "HEAD", fullContentSha256: "5".repeat(64)
  };
}

/** A stream that legitimately produced nothing: zero raw bytes offered, zero captured, capture complete. */
export function emptyStreamCapture(stream: "stdout" | "stderr"): StreamCaptureProvenance {
  return buildStreamCaptureProvenance({
    stream, rawByteCount: 0, deliveredByteCount: 0, runnerOutputTruncated: false,
    capturedText: "", includedText: "", includedContentByteCount: 0, truncationMethod: "NONE"
  });
}

/** A stream whose complete output was captured and rendered whole. */
export function capturedStreamProvenance(stream: "stdout" | "stderr", text: string): StreamCaptureProvenance {
  const byteCount = Buffer.byteLength(text, "utf8");
  return buildStreamCaptureProvenance({
    stream, rawByteCount: byteCount, deliveredByteCount: byteCount, runnerOutputTruncated: false,
    capturedText: text, includedText: text, includedContentByteCount: byteCount, truncationMethod: "NONE"
  });
}

/** A stream whose output the process runner discarded before the producer saw it -- the unknown-loss case. */
export function lostStreamCapture(stream: "stdout" | "stderr", rawByteCount = 4_096, deliveredByteCount = 0): StreamCaptureProvenance {
  return buildStreamCaptureProvenance({
    stream, rawByteCount, deliveredByteCount, runnerOutputTruncated: true,
    capturedText: "", includedText: "", includedContentByteCount: 0, truncationMethod: "NONE"
  });
}

/** A complete, schema-valid verification result whose capture provenance says its output survived whole. */
export function verificationResultEntry(
  overrides: Partial<VerificationArtifact["results"][number]> = {}
): VerificationArtifact["results"][number] {
  const withoutHash = {
    operation: "NPM_TEST" as const,
    displayCommand: "npm test",
    status: "PASSED" as const,
    exitCode: 0,
    summary: "npm test passed.",
    stdout: "",
    stdoutTruncation: untruncatedProvenance(""),
    stderr: "",
    stderrTruncation: untruncatedProvenance(""),
    runnerOutputTruncated: false,
    runnerStdoutBytes: 0,
    runnerStderrBytes: 0,
    stdoutCapture: emptyStreamCapture("stdout"),
    stderrCapture: emptyStreamCapture("stderr"),
    startedAt: "2026-08-05T00:00:00.000Z",
    finishedAt: "2026-08-05T00:00:01.000Z",
    ...overrides
  };
  return { ...withoutHash, resultHash: createHash("sha256").update(canonicalJson(withoutHash), "utf8").digest("hex") };
}

/** A single complete, schema-valid NDJSON log record. */
export function logRecordLine(message = "codex output", type: "output" | "warning" | "process" | "result" = "output"): string {
  return `${JSON.stringify({ type, message, payload: {} })}\n`;
}

/** Truthful LOG provenance for content persisted whole. */
export function completeLogProvenance(content: string, recordCount?: number): LogProvenance {
  const hash = createHash("sha256").update(content).digest("hex");
  return logProvenanceSchema.parse({
    schemaVersion: LOG_PROVENANCE_SCHEMA_VERSION,
    recordSchemaVersion: LOG_RECORD_SCHEMA_VERSION,
    originalRawByteCount: Buffer.byteLength(content, "utf8"),
    includedRawByteCount: Buffer.byteLength(content, "utf8"),
    omittedRawByteCount: 0,
    fullRawContentHash: hash,
    includedContentHash: hash,
    producerTruncated: false,
    truncationMethod: "NONE",
    captureCompleteness: "COMPLETE",
    recordCountOriginal: recordCount ?? (content.length === 0 ? 0 : content.slice(0, -1).split("\n").length),
    recordCountIncluded: recordCount ?? (content.length === 0 ? 0 : content.slice(0, -1).split("\n").length)
  } satisfies LogProvenance);
}

/**
 * The validated LOG evidence part `buildEvidencePart` produces for `content`,
 * for tests that exercise the RENDERING path directly.
 *
 * Deliberately faithful rather than convenient: the hash, decoded text, and
 * record list are derived from the same bytes the part carries, so a test can
 * only make the renderer see inconsistent input by asking for it explicitly
 * through `overrides`. (The byte-level rejections themselves are proven
 * against the real validator in log-provenance.test.ts, never against this.)
 */
export function validatedLogPart(
  content: Buffer | string,
  options: {
    provenance?: LogProvenance | null;
    producerTruncated?: boolean;
    producerOriginalByteCount?: number;
    producerOmittedByteCount?: number;
    producerTruncationMethod?: string;
    overrides?: Partial<ValidatedLogEvidencePart>;
  } = {}
): ValidatedLogEvidencePart {
  const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  const text = bytes.toString("utf8");
  const records = validateLogRecords(text, "The execution log artifact");
  return {
    artifactId: "00000000-0000-4000-8000-00000000log0",
    relativePath: "log.ndjson",
    rawBytesHash: createHash("sha256").update(bytes).digest("hex"),
    validatedIncludedBytes: bytes,
    validatedText: text,
    parsedRecords: records.ok ? records.records : [],
    logProvenance: options.provenance ?? null,
    producerTruncated: options.producerTruncated ?? false,
    // The ROW's account of the same stream. Defaults to agreeing with the
    // provenance, so a test that means to exercise something else does not
    // accidentally trip the row/provenance agreement check -- and a test that
    // means to exercise a disagreement states it explicitly.
    producerOriginalByteCount: options.producerOriginalByteCount
      ?? options.provenance?.originalRawByteCount
      ?? bytes.byteLength + (options.producerOmittedByteCount ?? 0),
    producerOmittedByteCount: options.producerOmittedByteCount ?? options.provenance?.omittedRawByteCount ?? 0,
    producerTruncationMethod: options.producerTruncationMethod ?? options.provenance?.truncationMethod ?? "NONE",
    ...options.overrides
  };
}

/** The provenance columns of an artifact ROW for content persisted whole. */
export function artifactRowProvenance(content: string): Pick<ArtifactRecord, "schemaVersion" | "fullContentSha256" | "originalByteCount" | "omittedByteCount" | "truncationMethod" | "provenanceJson"> {
  return {
    schemaVersion: EVIDENCE_ARTIFACT_SCHEMA_VERSION,
    fullContentSha256: createHash("sha256").update(content).digest("hex"),
    originalByteCount: Buffer.byteLength(content, "utf8"),
    omittedByteCount: 0,
    truncationMethod: "NONE",
    provenanceJson: "{}"
  };
}

/** A complete artifact row for `content`, with byte count and hashes that actually match it. */
export function artifactRow(id: string, sessionId: string, artifactType: string, relativePath: string, content: string): ArtifactRecord {
  return {
    id, sessionId, artifactType, relativePath,
    sha256: createHash("sha256").update(content).digest("hex"),
    byteCount: Buffer.byteLength(content, "utf8"),
    truncated: false,
    ...artifactRowProvenance(content),
    // A LOG row carries the producer's own provenance verbatim; every other
    // type has none beyond its columns.
    ...(artifactType === "LOG" ? { provenanceJson: canonicalJson(completeLogProvenance(content)) } : {})
  };
}
