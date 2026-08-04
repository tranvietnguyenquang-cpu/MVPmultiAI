import {
  canonicalJson, changedFilesArtifactSchema, EVIDENCE_ARTIFACT_SCHEMA_VERSION, finalGitArtifactSchema,
  parseRelayPatchPreview, patchArtifactSchema, sha256OfText, untruncatedProvenance, verificationArtifactSchema,
  type ChangedFileEntry, type ChangedFilesArtifact, type FinalGitArtifact, type PatchArtifact, type VerificationArtifact
} from "@project-relay/relay-v2-domain";
import type { VerificationResult } from "./verification-catalog.js";
import type { GitEvidence, GitEvidenceDelta } from "./workspace-evidence.js";

/**
 * Renders the execution engine's in-memory evidence into the canonical,
 * versioned artifact envelopes defined in relay-v2-domain -- the exact same
 * schemas the reviewer parses the persisted bytes back through.
 *
 * The point of routing every writer through here is that the bytes on disk
 * and the database projection of the same evidence are derived from ONE
 * in-memory value, so the reviewer's later canonical-equality check between
 * the two is a real check on storage integrity rather than a comparison of
 * two independently assembled shapes that were never expected to match.
 */

/**
 * Status of one changed path, derived from the baseline/final content-hash
 * presence recorded by `compareGitEvidence`. WorkspaceEvidenceService performs
 * no rename detection, so `renamedFrom` is always null today and a rename
 * surfaces as a delete plus an add.
 *
 * NOTE: `preExisting` means "this path was already dirty at baseline", not
 * "this path existed in the repository". A previously clean file modified by
 * the run therefore reports `added`. This mapping is deliberately identical to
 * the one the database projection uses -- the two representations must reduce
 * to the same canonical semantics, so they must classify identically, and
 * changing the classification is a separate change that has to move both
 * sides at once.
 */
export function toChangedFileEntry(file: GitEvidenceDelta["changedFiles"][number]): ChangedFileEntry {
  const status = !file.preExisting && file.finalSha256 ? "added" : file.preExisting && !file.finalSha256 ? "deleted" : "modified";
  return {
    path: file.path.replace(/\\/g, "/"),
    status,
    renamedFrom: null,
    binary: file.binary,
    baselineSha256: file.baselineSha256,
    finalSha256: file.finalSha256
  };
}

export function buildFinalGitArtifact(evidence: GitEvidence, delta: GitEvidenceDelta): FinalGitArtifact {
  const changedFiles = delta.changedFiles.map(toChangedFileEntry);
  return finalGitArtifactSchema.parse({
    schemaVersion: EVIDENCE_ARTIFACT_SCHEMA_VERSION,
    artifactType: "FINAL_GIT",
    branch: evidence.branch,
    head: evidence.head,
    clean: evidence.status.length === 0,
    changedFileCount: changedFiles.length,
    changedFiles,
    fullEvidenceHash: sha256OfText(canonicalJson({ evidence, delta })),
    captureEvidenceHash: evidence.evidenceHash,
    capturedAt: evidence.capturedAt,
    forbiddenGitMutationSuspected: delta.forbiddenGitMutationSuspected,
    // The envelope is written whole; any loss is inside `patchProvenance`,
    // which the PATCH artifact carries.
    truncation: untruncatedProvenance("")
  } satisfies FinalGitArtifact);
}

/**
 * Coverage is proven from the diff's own FILE HEADERS, parsed exactly.
 *
 * It used to be proven by `unifiedDiff.includes(file.path)` -- a substring
 * test that a path appearing anywhere in the diff satisfied, including inside
 * an unrelated file's hunk BODY. A changed file with no diff of its own could
 * therefore be reported as covered because some other file's added line
 * happened to mention it. A changed path that the headers do not name is now
 * left out of both lists, and the reviewer blocks on it -- silence is never
 * read as coverage.
 */
export function buildPatchArtifact(
  patchKind: "FINAL" | "BASELINE", baselineHead: string, evidence: GitEvidence, changedFiles: readonly ChangedFileEntry[]
): PatchArtifact {
  const unifiedDiff = evidence.patchPreview;
  const parsed = parseRelayPatchPreview(unifiedDiff);
  // An unparseable diff proves coverage for nothing at all. Recorded that way
  // rather than refused here: the reviewer is the layer that decides a run
  // with unprovable diff coverage cannot be reviewed authoritatively.
  const headerPaths = parsed.ok ? new Set(parsed.paths) : new Set<string>();
  const covered: string[] = [];
  const omitted: Array<{ path: string; reason: "SENSITIVE_PATH" }> = [];
  for (const file of changedFiles) {
    if (evidence.patchOmittedForSensitivePaths) omitted.push({ path: file.path, reason: "SENSITIVE_PATH" });
    else if (headerPaths.has(file.path.replace(/\\/g, "/"))) covered.push(file.path);
  }
  return patchArtifactSchema.parse({
    schemaVersion: EVIDENCE_ARTIFACT_SCHEMA_VERSION,
    artifactType: "PATCH",
    patchKind,
    baselineHead,
    finalHead: evidence.head,
    unifiedDiff,
    coveredPaths: covered,
    omittedPaths: omitted,
    fullContentHash: evidence.patchProvenance.fullContentSha256,
    truncation: evidence.patchProvenance
  } satisfies PatchArtifact);
}

export function buildChangedFilesArtifact(changedFiles: readonly ChangedFileEntry[]): ChangedFilesArtifact {
  const files = [...changedFiles].sort((left, right) => left.path.localeCompare(right.path));
  return changedFilesArtifactSchema.parse({
    schemaVersion: EVIDENCE_ARTIFACT_SCHEMA_VERSION,
    artifactType: "CHANGED_FILES",
    files,
    fileCount: files.length,
    manifestHash: sha256OfText(canonicalJson(files)),
    truncation: untruncatedProvenance("")
  } satisfies ChangedFilesArtifact);
}

export function buildVerificationArtifact(results: readonly VerificationResult[]): VerificationArtifact {
  const mapped = results.map(result => ({
    operation: result.operation,
    displayCommand: result.displayCommand,
    status: result.timedOut ? "TIMED_OUT" as const : result.cancelled ? "CANCELLED" as const : result.passed ? "PASSED" as const : "FAILED" as const,
    exitCode: result.exitCode,
    summary: result.summary,
    stdout: result.stdoutPreview,
    stdoutTruncation: result.stdoutProvenance,
    stderr: result.stderrPreview,
    stderrTruncation: result.stderrProvenance,
    runnerOutputTruncated: result.runnerOutputTruncated,
    runnerStdoutBytes: result.runnerStdoutBytes,
    runnerStderrBytes: result.runnerStderrBytes,
    stdoutCapture: result.stdoutCapture,
    stderrCapture: result.stderrCapture,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    resultHash: result.resultHash
  }));
  return verificationArtifactSchema.parse({
    schemaVersion: EVIDENCE_ARTIFACT_SCHEMA_VERSION,
    artifactType: "VERIFICATION",
    results: mapped,
    fullContentHash: sha256OfText(canonicalJson(mapped)),
    truncation: untruncatedProvenance("")
  } satisfies VerificationArtifact);
}

/**
 * The worst inner-content provenance across a verification run, so the
 * artifact row reflects any stream the producer could not persist whole --
 * including one whose bytes were discarded at the process-runner boundary
 * before this producer ever saw them (`captureTruncated`), which is what makes
 * runner-level output loss block an AUTHORITATIVE review instead of being
 * recorded as a complete, passing operation.
 */
export function verificationInnerTruncation(artifact: VerificationArtifact): VerificationArtifact["results"][number]["stdoutTruncation"] {
  for (const result of artifact.results) {
    if (result.stdoutTruncation.producerTruncated || result.stdoutTruncation.captureTruncated) return result.stdoutTruncation;
    if (result.stderrTruncation.producerTruncated || result.stderrTruncation.captureTruncated) return result.stderrTruncation;
  }
  return untruncatedProvenance("");
}
