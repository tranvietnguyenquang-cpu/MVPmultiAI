import { createHash } from "node:crypto";
import { z } from "zod";
import { redactSecrets } from "@project-relay/local-safety";
import {
  AUTHORITATIVE_REVIEW_MATERIAL_BUDGET, boundLogRecordsToBytes, boundTextToBytes, canonicalJson, decodeStrictUtf8,
  enforceEnvelopeByteBudget, enforceMaterialByteLedger, executorSelectionSchema, hashTaskSpec, logProvenanceSchema,
  modelSelectionSchema, parseRelayPatchPreview, producerTruncationSchema, reasoningEffortSchema, reviewAuthoritySchema,
  reviewerSelectionSchema, semanticValueHash, sha256OfBytes, streamCaptureProvenanceSchema,
  truncationMethodSchema, validateLogRecords, verificationOperationSchema,
  type NormalizedTaskSpec, type ReviewAuthority, type ReviewMaterialLedger
} from "@project-relay/relay-v2-domain";
import type { ValidatedLogEvidencePart, ValidatedReviewEvidencePart } from "./artifact-evidence.js";
import { buildReviewMaterialSections, type BuiltMaterialSections } from "./review-material-sections.js";

const sha256Pattern = /^[a-f0-9]{64}$/;

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const boundedEvidenceText = (maxLength: number) => z.string().max(maxLength);

/** One changed file as recorded by WorkspaceEvidenceService's baseline/final delta -- no rename detection is performed by that service, so a rename surfaces as a delete plus an add. */
export const reviewGitChangedFileSchema = z.object({
  path: z.string().max(1024),
  status: z.enum(["added", "modified", "deleted"]),
  binary: z.boolean().nullable()
}).strict();

export const reviewGitEvidenceSummarySchema = z.object({
  available: z.boolean(),
  branch: z.string().max(500),
  head: z.string().max(100),
  dirty: z.boolean(),
  changedFiles: z.array(reviewGitChangedFileSchema).max(500),
  diffPreview: boundedEvidenceText(200_000),
  diffTruncated: z.boolean(),
  diffOmittedForSensitivePaths: z.boolean()
}).strict();
export type ReviewGitEvidenceSummary = z.infer<typeof reviewGitEvidenceSummarySchema>;

export const reviewVerificationEvidenceSchema = z.object({
  operation: z.string().max(100),
  displayCommand: z.string().max(200),
  passed: z.boolean(),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  cancelled: z.boolean(),
  summary: z.string().max(2_000),
  stdoutPreview: boundedEvidenceText(20_000),
  stdoutTruncated: z.boolean(),
  stderrPreview: boundedEvidenceText(20_000),
  stderrTruncated: z.boolean(),
  /**
   * Runner-boundary output accounting, bound into the capsule (and therefore
   * into reviewInputHash) rather than dropped: whether an operation's output
   * survived to the evidence record is part of what a reviewer is deciding on,
   * and a PASS with lost output must never be indistinguishable from a PASS
   * with complete output.
   */
  runnerOutputTruncated: z.boolean(),
  runnerStdoutBytes: z.number().int().min(0),
  runnerStderrBytes: z.number().int().min(0),
  stdoutCapture: streamCaptureProvenanceSchema,
  stderrCapture: streamCaptureProvenanceSchema,
  startedAt: z.string().max(50),
  finishedAt: z.string().max(50),
  /** Echoed verbatim from the persisted VerificationResult's own self-referential integrity hash (see verification-catalog.ts); required, never fabricated. */
  resultHash: z.string().regex(sha256Pattern)
}).strict();
export type ReviewVerificationEvidence = z.infer<typeof reviewVerificationEvidenceSchema>;

export const reviewArtifactManifestItemSchema = z.object({
  /** The ExecutionArtifact row id whose byte-validated content this evidence was proven from -- bound into the capsule so the rendered material can name its source without a second lookup. */
  artifactId: z.string().uuid(),
  artifactType: z.string().max(50),
  relativePath: z.string().max(1024),
  sha256: z.string().regex(sha256Pattern),
  byteCount: z.number().int().min(0),
  truncated: z.boolean()
}).strict();
export type ReviewArtifactManifestItem = z.infer<typeof reviewArtifactManifestItemSchema>;

/**
 * The execution's `LOG` artifact content (a redacted NDJSON provider-event
 * transcript, see ExecutionArtifactStore.finalizeLog), head+tail bounded to
 * the EXECUTION_LOG material-budget category and embedded directly from the
 * exact bytes byte-level artifact validation already read and hash-verified
 * -- never a second, independent re-read. `available: false` only for a
 * session with no LOG artifact at all (e.g. a diagnostic FakeExecutor
 * session); an AUTHORITATIVE codex-cli review always has one (LOG is a
 * required artifact type).
 */
export const reviewExecutionLogEvidenceSchema = z.object({
  available: z.boolean(),
  /** The reviewer-rendered transcript: whole records only, omission marker included. */
  preview: z.string(),

  // --- PRODUCER side: what the execution writer says about the real stream.
  // Carried through unchanged and NEVER overwritten by any reviewer-side
  // value below -- the two answer different questions, and collapsing them is
  // how "the producer lost 4 MB" became indistinguishable from "the reviewer
  // trimmed the render".
  /**
   * The PRODUCER's own versioned provenance, verbatim. Never re-derived from
   * the artifact row's columns: a producer that honestly reported "I cannot
   * prove this log is complete" must reach the reviewer saying exactly that,
   * and re-deriving would quietly upgrade it to a claim of completeness the
   * producer never made. Null only for a DIAGNOSTIC review or a session with
   * no LOG at all; an AUTHORITATIVE review requires it (see
   * assertAuthoritativeLogProvenance).
   */
  producerProvenance: logProvenanceSchema.nullable(),
  /** True when the EXECUTION WRITER could not persist the whole log. Mirrors `producerProvenance.producerTruncated` whenever provenance is present. */
  producerTruncated: z.boolean(),

  // --- REVIEWER side: what this materializer did with the bytes it was given.
  /** Bytes of validated LOG artifact handed to the reviewer -- equal to `producerProvenance.includedRawByteCount`, NOT to the producer's original stream size. */
  sourceByteCount: z.number().int().min(0),
  /** SHA-256 of exactly those validated bytes; equal to `producerProvenance.includedContentHash`. */
  includedContentSha256: z.string().regex(sha256Pattern).nullable(),
  /** Real content bytes rendered, EXCLUDING the omission marker. */
  reviewerIncludedByteCount: z.number().int().min(0),
  /** Source bytes this reviewer did not render. */
  reviewerOmittedByteCount: z.number().int().min(0),
  reviewerMarkerByteCount: z.number().int().min(0),
  /** Measured size of `preview` itself, marker included -- always `reviewerIncludedByteCount + reviewerMarkerByteCount`. */
  reviewerFinalRenderedByteCount: z.number().int().min(0),
  /** SHA-256 of the exact rendered `preview` text. */
  reviewerRenderedSha256: z.string().regex(sha256Pattern).nullable(),
  /** True when this reviewer bounded complete, validated bytes for rendering. */
  reviewerTruncated: z.boolean(),
  /** How THIS reviewer bounded the render. The producer's own method lives in `producerProvenance.truncationMethod`. */
  reviewerTruncationMethod: truncationMethodSchema,
  /** Complete NDJSON records actually rendered. Records are never split: the reviewer bounds on record boundaries only. */
  reviewerIncludedRecordCount: z.number().int().min(0),
  /** Complete records the reviewer dropped to fit the budget. */
  reviewerOmittedRecordCount: z.number().int().min(0),

  /** Disclosure convenience: content is missing from the render for EITHER reason. Never a substitute for reading the two sides above. */
  anyTruncation: z.boolean()
}).strict();
export type ReviewExecutionLogEvidence = z.infer<typeof reviewExecutionLogEvidenceSchema>;

export const EMPTY_EXECUTION_LOG_EVIDENCE: ReviewExecutionLogEvidence = Object.freeze({
  available: false, preview: "", producerProvenance: null, producerTruncated: false,
  sourceByteCount: 0, includedContentSha256: null,
  reviewerIncludedByteCount: 0, reviewerOmittedByteCount: 0, reviewerMarkerByteCount: 0,
  reviewerFinalRenderedByteCount: 0, reviewerRenderedSha256: null,
  reviewerTruncated: false, reviewerTruncationMethod: "NONE",
  reviewerIncludedRecordCount: 0, reviewerOmittedRecordCount: 0, anyTruncation: false
});

export type ExecutionLogSummaryResult =
  | { ok: true; evidence: ReviewExecutionLogEvidence }
  | { ok: false; reason: string };

/**
 * Renders the COMPLETE validated LOG evidence part into reviewer-visible
 * evidence, bounding it to the EXECUTION_LOG material-budget category ON
 * RECORD BOUNDARIES and carrying the producer's provenance through untouched.
 *
 * Takes the whole `ValidatedLogEvidencePart` deliberately. The previous
 * signature -- `(bytes, producerTruncated)` -- could not express the thing
 * that matters most about a log (what the producer says the FULL stream was),
 * so callers passed a Buffer and a boolean scraped off the artifact row and
 * the validated provenance was silently discarded. There is now no way to call
 * this function without the provenance, because there is no parameter to leave
 * out.
 *
 * The part's own claims are re-proved against its bytes rather than trusted:
 * the bytes must still hash to `rawBytesHash`, still decode under STRICT UTF-8
 * to `validatedText`, still validate as complete NDJSON to the same record
 * count, and any provenance present must still describe exactly these bytes.
 * Reviewer-side bounding then drops whole records only, so the rendered
 * transcript can never contain half an event, and every reviewer-side count is
 * reported separately from the producer's -- never on top of it.
 */
export function summarizeExecutionLogEvidence(log: ValidatedLogEvidencePart | null): ExecutionLogSummaryResult {
  if (log === null) return { ok: true, evidence: EMPTY_EXECUTION_LOG_EVIDENCE };
  const label = "The execution log artifact";
  const content = log.validatedIncludedBytes;
  const includedContentSha256 = sha256OfBytes(content);
  if (includedContentSha256 !== log.rawBytesHash) {
    return { ok: false, reason: `${label} no longer hashes to the value its validation recorded.` };
  }
  const decoded = decodeStrictUtf8(content, label);
  if (!decoded.ok) return { ok: false, reason: decoded.reason };
  if (decoded.text !== log.validatedText) {
    return { ok: false, reason: `${label} decodes to different text than its validation recorded.` };
  }
  const records = validateLogRecords(decoded.text, label);
  if (!records.ok) return { ok: false, reason: records.reason };
  if (records.recordCount !== log.parsedRecords.length) {
    return { ok: false, reason: `${label} validates to ${records.recordCount} record(s), but its validation recorded ${log.parsedRecords.length}.` };
  }

  // The producer's account must still describe THESE bytes. This is the same
  // check artifact validation makes; repeating it here means the rendering
  // path cannot be reached with provenance that has drifted from its content.
  const producerProvenance = log.logProvenance;
  if (producerProvenance) {
    if (producerProvenance.includedRawByteCount !== content.byteLength) {
      return { ok: false, reason: `${label} carries provenance declaring ${producerProvenance.includedRawByteCount} included byte(s) but holds ${content.byteLength}.` };
    }
    if (producerProvenance.includedContentHash !== includedContentSha256) {
      return { ok: false, reason: `${label} carries provenance whose included-content hash does not match these bytes.` };
    }
    if (producerProvenance.recordCountIncluded !== records.recordCount) {
      return { ok: false, reason: `${label} carries provenance declaring ${producerProvenance.recordCountIncluded} included record(s) but contains ${records.recordCount}.` };
    }
    if (producerProvenance.producerTruncated !== log.producerTruncated) {
      return { ok: false, reason: `${label} carries provenance that disagrees with its artifact row about producer truncation.` };
    }
  }

  const includedCap = AUTHORITATIVE_REVIEW_MATERIAL_BUDGET.categories.EXECUTION_LOG.maxIncludedBytes;
  // Record-aligned, applied only AFTER every included record has been
  // validated -- so reviewer-side bounding can never be what makes a log
  // unparseable, and never renders a fragment of an event.
  const bounded = boundLogRecordsToBytes(decoded.text, includedCap);
  const sourceByteCount = utf8ByteLengthOf(decoded.text);
  const reviewerTruncated = bounded.omittedRecordCount > 0;
  return {
    ok: true,
    evidence: {
      available: true,
      preview: bounded.text,
      producerProvenance,
      producerTruncated: log.producerTruncated,
      sourceByteCount,
      includedContentSha256,
      reviewerIncludedByteCount: bounded.includedContentByteCount,
      reviewerOmittedByteCount: sourceByteCount - bounded.includedContentByteCount,
      reviewerMarkerByteCount: bounded.markerByteCount,
      reviewerFinalRenderedByteCount: bounded.includedContentByteCount + bounded.markerByteCount,
      reviewerRenderedSha256: sha256Hex(bounded.text),
      reviewerTruncated,
      reviewerTruncationMethod: reviewerTruncated ? "HEAD_AND_TAIL" : "NONE",
      reviewerIncludedRecordCount: bounded.includedRecordCount,
      reviewerOmittedRecordCount: bounded.omittedRecordCount,
      anyTruncation: reviewerTruncated || log.producerTruncated
    }
  };
}

function utf8ByteLengthOf(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * The complete, immutable set of reviewer-visible input. Recomputed fresh from
 * current source-of-truth rows (never trusted from caller input) both when a
 * review is requested and again immediately before a verdict is accepted.
 * Persisted verbatim as ReviewRequest.reviewInputJson; reviewer.review() is
 * given exactly this object (parsed back from the persisted JSON) and nothing
 * assembled separately. Task title/objective/context are bound directly
 * (live-read, not derived from taskSpecHash alone) so that a bug or direct
 * mutation which changes them without bumping the task's spec version is
 * still hash-visible.
 */
/** Kept as a plain ZodObject (not the .superRefine()-wrapped export below) so callers -- notably tests asserting hash coverage over every declared field -- can still reach `.shape`, which a ZodEffects wrapper does not expose directly. */
export const reviewInputCapsuleObjectSchema = z.object({
  reviewRequestId: z.string().uuid(),
  executionSessionId: z.string().uuid(),
  projectId: z.string().uuid(),
  taskId: z.string().uuid(),
  reviewerId: z.string().min(1).max(100),
  reviewAuthority: reviewAuthoritySchema,
  diagnostic: z.boolean(),
  approvalId: z.string().uuid(),
  approvalStatus: z.string().min(1).max(50),
  approvedReviewer: reviewerSelectionSchema,
  taskSelectedReviewer: reviewerSelectionSchema,
  executionExecutorId: z.string().min(1).max(100),
  taskTitle: z.string().min(1).max(200),
  taskObjective: z.string().min(1).max(10_000),
  taskContext: z.string().max(50_000),
  taskSpecHash: z.string().regex(sha256Pattern),
  /** Independently recomputed from approval.approvedSpecJson's embedded task spec via hashTaskSpec; must equal taskSpecHash. */
  canonicalTaskSpecHash: z.string().regex(sha256Pattern),
  /** Independently recomputed from the task's current normalizedSpecJson column. */
  taskNormalizedSpecHash: z.string().regex(sha256Pattern),
  approvalSnapshotHash: z.string().regex(sha256Pattern),
  executionStatus: z.string().min(1).max(50),
  executionResultStatus: z.string().min(1).max(50),
  executionSummary: z.string().max(20_000),
  executionSummaryHash: z.string().regex(sha256Pattern),
  executionCapsuleHash: z.string().regex(sha256Pattern),
  /** Independently recomputed from the current raw capsuleJson column, never trusted from a cached/embedded value. */
  executionCapsuleJsonHash: z.string().regex(sha256Pattern),
  baselineGitEvidenceHash: z.string().regex(sha256Pattern),
  finalGitEvidenceHash: z.string().regex(sha256Pattern),
  verificationResultsHash: z.string().regex(sha256Pattern),
  executionArtifactSetHash: z.string().regex(sha256Pattern),
  finalBranch: z.string(),
  finalHead: z.string(),
  requestedAt: z.string().datetime(),
  reviewPolicyVersion: z.string().min(1).max(50),
  // --- Milestone 2.3B corrective pass: actual reviewable evidence content,
  // not merely hashes of it. Every value below is independently recomputed
  // from the same live session/task rows every time this capsule is built
  // (request time and pre-verdict revalidation) -- never trusted from a
  // caller or cached separately from the hash fields above.
  taskConstraints: z.array(z.string().max(2_000)).max(100),
  acceptanceCriteria: z.array(z.string().max(2_000)).max(100),
  approvedExecutorSelection: executorSelectionSchema,
  approvedModel: modelSelectionSchema,
  approvedEffort: reasoningEffortSchema,
  approvedVerificationOperations: z.array(verificationOperationSchema).max(3),
  baselineGitEvidence: reviewGitEvidenceSummarySchema,
  finalGitEvidence: reviewGitEvidenceSummarySchema,
  verificationEvidence: z.array(reviewVerificationEvidenceSchema).max(10),
  executionArtifactManifest: z.array(reviewArtifactManifestItemSchema).max(200),
  executionLogEvidence: reviewExecutionLogEvidenceSchema
}).strict();

/**
 * The capsule schema actually used everywhere else in this package: adds the
 * duplicate-artifact-manifest-entry check on top of reviewInputCapsuleObjectSchema.
 * No category may evade the total material budget by splitting identical or
 * duplicate content across many manifest entries -- a duplicate
 * (artifactType, relativePath) pair is rejected outright rather than
 * silently double-counted or silently deduplicated.
 */
export const reviewInputCapsuleSchema = reviewInputCapsuleObjectSchema.superRefine((value, ctx) => {
  const seen = new Set<string>();
  for (const artifact of value.executionArtifactManifest) {
    const key = `${artifact.artifactType}:${artifact.relativePath}`;
    if (seen.has(key)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["executionArtifactManifest"], message: `duplicate execution artifact manifest entry '${key}'` });
    seen.add(key);
  }
});
export type ReviewInputCapsule = z.infer<typeof reviewInputCapsuleSchema>;

export function computeReviewInputHash(capsule: ReviewInputCapsule): string {
  return sha256Hex(canonicalJson(reviewInputCapsuleSchema.parse(capsule)));
}

export type RequestHashIdentity = {
  reviewInputHash: string;
  reviewerConfigHash: string;
  reviewerId: string;
  reviewAuthority: ReviewAuthority;
  requestedBy: string;
  attempt: number;
  reviewPolicyVersion: string;
};

/**
 * Wraps reviewInputHash together with reviewerConfigHash (every value that
 * affects RelayReviewer.review()'s behavior must be bound — task/execution
 * evidence alone is not enough) and the request's administrative/authority
 * identity. requestedBy/attempt are not themselves part of what the reviewer
 * evaluates, so they live outside reviewInputHash itself; reviewerId/
 * reviewAuthority/reviewPolicyVersion are repeated here (already inside the
 * capsule too) so requestHash is independently reconstructible without
 * dereferencing into reviewInputJson.
 */
export function computeRequestHash(identity: RequestHashIdentity): string {
  return sha256Hex(canonicalJson(identity));
}

/**
 * Parses `json` with `schema`, recomputes its hash from the canonicalized,
 * validated value (never trusting the raw stored string), and requires it to
 * equal `expectedHash`. Used identically for reviewInputJson/reviewInputHash
 * and reviewerConfigJson/reviewerConfigHash: a persisted value is only
 * trusted once it is shown to still be schema-valid AND to still hash to its
 * own recorded hash.
 */
export function verifyJsonHashBinding<T>(schema: z.ZodType<T>, json: string, expectedHash: string): { ok: true; value: T } | { ok: false } {
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return { ok: false }; }
  const result = schema.safeParse(parsed);
  if (!result.success) return { ok: false };
  if (sha256Hex(canonicalJson(result.data)) !== expectedHash) return { ok: false };
  return { ok: true, value: result.data };
}

/** Recomputes the specHash of the task spec actually embedded in an approval snapshot, independent of any cached column. */
export function computeCanonicalTaskSpecHash(approvedSpecJson: string): string {
  const parsed = JSON.parse(approvedSpecJson) as { task: NormalizedTaskSpec };
  return hashTaskSpec(parsed.task);
}

/** Recomputes what Task.specHash should be from the task's current normalizedSpecJson column, independent of the cached specHash value. */
export function computeTaskNormalizedSpecHash(normalizedSpecJson: string): string {
  return hashTaskSpec(JSON.parse(normalizedSpecJson) as NormalizedTaskSpec);
}

/**
 * Verifies that a persisted execution capsule has not diverged from its own
 * embedded, self-referential hash, and that the ExecutionSession.capsuleHash
 * column agrees. Never trusts `capsuleHash` in isolation — both the embedded
 * and the column value must match a hash independently recomputed from
 * `capsuleJson` itself. Returns true for the (fake-executor) no-capsule case
 * where `capsuleJson === "{}"` and `storedCapsuleHash` is null.
 */
export function verifyCapsuleIntegrity(capsuleJson: string, storedCapsuleHash: string | null): boolean {
  if (storedCapsuleHash === null) return capsuleJson === "{}";
  let parsed: unknown;
  try { parsed = JSON.parse(capsuleJson); } catch { return false; }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
  const { capsuleHash: embeddedHash, ...withoutHash } = parsed as Record<string, unknown>;
  if (typeof embeddedHash !== "string") return false;
  const recomputed = sha256Hex(canonicalJson(withoutHash));
  return recomputed === embeddedHash && recomputed === storedCapsuleHash;
}

export type EvidenceIntegrityResult = { ok: true } | { ok: false; reason: string };

// ============================================================================
// Milestone 2.3B corrective pass -- strict, fail-closed persisted evidence
// schemas. These mirror the EXACT shapes the production writers persist:
//   - GitEvidence / GitEvidenceDelta: packages/relay-v2-execution/src/workspace-evidence.ts
//   - VerificationResult: packages/relay-v2-execution/src/verification-catalog.ts
// This package cannot import relay-v2-execution (enforced by
// isolation.relay-v2.test.ts), so the shapes are reproduced here as strict
// Zod schemas rather than imported types -- `.strict()` at every object level
// means an unknown/renamed/added field is rejected, not silently ignored.
// Malformed JSON, wrong shape, or a value that merely LOOKS like evidence
// (e.g. `{ "unexpected": true }`) is ALWAYS a hard `{ ok: false }` failure
// here, never silently degraded into `available: false` / `[]` further down
// this pipeline -- that permissive degrade was the original defect.
// ============================================================================

const sha256Hex64 = /^[a-f0-9]{64}$/;
const gitObjectId = /^[a-f0-9]{40}$|^[a-f0-9]{64}$/;

/** Rejects an absolute path or any ".."-traversal segment; every persisted Git evidence path must be repository-relative. */
const safeRepoRelativePath = (maxLength: number) => z.string().max(maxLength).refine(
  value => !/^([a-zA-Z]:)?[\\/]/.test(value) && !value.split(/[\\/]/).includes(".."),
  { message: "must be a safe, repository-relative path (no absolute path, no '..' traversal segment)" }
);

const persistedGitStatusEntrySchema = z.object({
  path: safeRepoRelativePath(4_096),
  indexStatus: z.string().length(1),
  worktreeStatus: z.string().length(1),
  staged: z.boolean(),
  unstaged: z.boolean(),
  untracked: z.boolean(),
  sensitive: z.boolean(),
  contentSha256: z.string().regex(sha256Hex64).nullable(),
  byteCount: z.number().int().min(0).nullable(),
  binary: z.boolean().nullable(),
  indexObjectId: z.string().nullable().optional(),
  headObjectId: z.string().nullable().optional(),
  worktreeObjectId: z.string().nullable().optional()
}).strict();

const persistedProtectedPathEvidenceSchema = z.object({
  path: safeRepoRelativePath(4_096),
  exists: z.boolean(),
  contentSha256: z.string().regex(sha256Hex64).nullable(),
  indexObjectId: z.string().nullable(),
  headObjectId: z.string().nullable(),
  worktreeObjectId: z.string().nullable()
}).strict();

/** Mirrors WorkspaceEvidenceService's persisted `GitEvidence` (see workspace-evidence.ts). */
const persistedGitEvidenceSchema = z.object({
  repositoryRoot: z.string().min(1),
  branch: z.string(),
  head: z.string().regex(gitObjectId),
  dirty: z.boolean(),
  status: z.array(persistedGitStatusEntrySchema).max(5_000),
  stagedCount: z.number().int().min(0),
  unstagedCount: z.number().int().min(0),
  untrackedCount: z.number().int().min(0),
  patchPreview: z.string(),
  patchSha256: z.string().regex(sha256Hex64),
  patchTruncated: z.boolean(),
  patchProvenance: producerTruncationSchema,
  patchOmittedForSensitivePaths: z.boolean(),
  stashRef: z.string().nullable().optional(),
  stashListHash: z.string().regex(sha256Hex64).optional(),
  indexIdentitySha256: z.string().regex(sha256Hex64).optional(),
  protectedPaths: z.array(persistedProtectedPathEvidenceSchema).max(5_000).optional(),
  capturedAt: z.string().datetime(),
  evidenceHash: z.string().regex(sha256Hex64)
}).strict();

const persistedGitEvidenceDeltaChangedFileSchema = z.object({
  path: safeRepoRelativePath(4_096),
  baselineSha256: z.string().regex(sha256Hex64).nullable(),
  finalSha256: z.string().regex(sha256Hex64).nullable(),
  preExisting: z.boolean(),
  binary: z.boolean().nullable()
}).strict();

/** Mirrors `compareGitEvidence`'s persisted `GitEvidenceDelta` (see workspace-evidence.ts). */
const persistedGitEvidenceDeltaSchema = z.object({
  baselineHash: z.string().regex(sha256Hex64),
  finalHash: z.string().regex(sha256Hex64),
  changedFiles: z.array(persistedGitEvidenceDeltaChangedFileSchema).max(5_000),
  headChanged: z.boolean(),
  branchChanged: z.boolean(),
  preExistingChangesDestroyed: z.array(z.string()).max(5_000),
  preExistingChangesHidden: z.array(z.string()).max(5_000),
  unaccountedPreExistingPaths: z.array(z.string()).max(5_000),
  stashChanged: z.boolean(),
  forbiddenGitMutationSuspected: z.boolean()
}).strict().superRefine((value, ctx) => {
  const seen = new Set<string>();
  for (const entry of value.changedFiles) {
    if (seen.has(entry.path)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["changedFiles"], message: `duplicate/conflicting changed-file path '${entry.path}'` });
    seen.add(entry.path);
  }
});

/** Mirrors the `{ evidence, delta }` envelope ExecutionEngine persists into `ExecutionSession.finalEvidenceJson`. */
const persistedFinalGitEnvelopeSchema = z.object({
  evidence: persistedGitEvidenceSchema,
  delta: persistedGitEvidenceDeltaSchema
}).strict();

/** Recomputes WorkspaceEvidenceService.capture's self-referential `evidenceHash` (sha256 of every OTHER field, canonicalized) and requires it to still match. Catches tampering that edits evidence content without recomputing its own hash. */
function gitEvidenceSelfHashMatches(evidence: z.infer<typeof persistedGitEvidenceSchema>): boolean {
  const rest: Record<string, unknown> = { ...evidence };
  delete rest.capturedAt;
  delete rest.evidenceHash;
  return sha256Hex(canonicalJson(rest)) === evidence.evidenceHash;
}

/** Mirrors VerificationCatalogRunner's persisted `VerificationResult` (see verification-catalog.ts). PASS with a nonzero exit code is rejected by construction. */
const persistedVerificationResultSchema = z.object({
  operation: verificationOperationSchema,
  displayCommand: z.string().max(200),
  passed: z.boolean(),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  cancelled: z.boolean(),
  summary: z.string().max(2_000),
  stdoutPreview: z.string(),
  stdoutTruncated: z.boolean(),
  stdoutProvenance: producerTruncationSchema,
  stderrPreview: z.string(),
  stderrTruncated: z.boolean(),
  stderrProvenance: producerTruncationSchema,
  runnerOutputTruncated: z.boolean(),
  runnerStdoutBytes: z.number().int().min(0),
  runnerStderrBytes: z.number().int().min(0),
  stdoutCapture: streamCaptureProvenanceSchema,
  stderrCapture: streamCaptureProvenanceSchema,
  startedAt: z.string(),
  finishedAt: z.string(),
  resultHash: z.string().regex(sha256Hex64)
}).strict().superRefine((value, ctx) => {
  if (value.passed && value.exitCode !== 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["exitCode"], message: "a verification result marked passed must have exit code 0" });
  }
});

/** Recomputes VerificationCatalogRunner's self-referential `resultHash` and requires it to still match. */
function verificationResultSelfHashMatches(result: z.infer<typeof persistedVerificationResultSchema>): boolean {
  const { resultHash, ...rest } = result;
  return sha256Hex(canonicalJson(rest)) === resultHash;
}

const persistedVerificationResultsSchema = z.array(persistedVerificationResultSchema).max(10);

/**
 * Central, explicit statement of which reviewer-visible evidence categories
 * are REQUIRED for an AUTHORITATIVE review, which are OPTIONAL, which may
 * legitimately be empty, and which may be truncated. Consulted by
 * ReviewEngine.checkEligibility (via requireAuthoritativeEvidence below) --
 * a REQUIRED item that is absent, malformed, or fails its integrity check
 * blocks the review with ERROR/STALE and produces no verdict; nothing here
 * silently substitutes an empty string for missing content.
 */
export type AuthoritativeEvidencePolicy = {
  required: readonly string[];
  optional: readonly string[];
  legitimatelyEmpty: readonly string[];
  truncatable: readonly string[];
  nonTruncatable: readonly string[];
};

export const AUTHORITATIVE_EVIDENCE_POLICY: AuthoritativeEvidencePolicy = Object.freeze({
  required: Object.freeze([
    "FINAL_GIT_DIFF", "CHANGED_FILE_LIST", "VERIFICATION_STDOUT", "VERIFICATION_STDERR",
    "APPROVED_SPEC", "CONSTRAINTS", "ACCEPTANCE_CRITERIA", "VERIFICATION_REQUIREMENTS",
    "EXECUTION_SUMMARY", "ARTIFACT_MANIFEST"
  ]),
  optional: Object.freeze(["BASELINE_GIT_DIFF"]),
  // A verification operation that legitimately produced zero bytes on a
  // stream (e.g. a passing `npm test` with no stdout) is represented
  // explicitly by an empty string plus its own resultHash over that exact
  // empty value -- never a missing/omitted field. CHANGED_FILE_LIST is
  // legitimately empty when a run touched no files.
  legitimatelyEmpty: Object.freeze(["VERIFICATION_STDOUT", "VERIFICATION_STDERR", "CHANGED_FILE_LIST"]),
  truncatable: Object.freeze(["FINAL_GIT_DIFF", "BASELINE_GIT_DIFF", "VERIFICATION_STDOUT", "VERIFICATION_STDERR"]),
  nonTruncatable: Object.freeze(["APPROVED_SPEC", "CONSTRAINTS", "ACCEPTANCE_CRITERIA", "VERIFICATION_REQUIREMENTS", "ARTIFACT_MANIFEST"])
});

/**
 * Distinguishes well-formed-empty ("{}", the legitimate "this executor
 * produces no Git evidence" case) from malformed non-empty Git evidence JSON.
 * `kind` selects whether `evidenceJson` is a bare persisted `GitEvidence`
 * (baseline) or the `{ evidence, delta }` envelope (final). A hard failure
 * here must never be silently absorbed into an "unavailable" evidence
 * summary for an AUTHORITATIVE (or any) review: the caller is expected to
 * treat a `false` result as an eligibility/staleness failure, never a
 * passable "no evidence" state.
 */
export function checkGitEvidenceIntegrity(evidenceJson: string, label: string, kind: "baseline" | "final"): EvidenceIntegrityResult {
  if (evidenceJson === "{}") return { ok: true };
  let parsed: unknown;
  try { parsed = JSON.parse(evidenceJson); } catch { return { ok: false, reason: `${label} Git evidence is not valid JSON and cannot be reviewed.` }; }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: `${label} Git evidence is not a JSON object and cannot be reviewed.` };
  }
  if (kind === "baseline") {
    const result = persistedGitEvidenceSchema.safeParse(parsed);
    if (!result.success) return { ok: false, reason: `${label} Git evidence failed strict schema validation and cannot be reviewed: ${result.error.issues[0]?.message ?? "invalid shape"}.` };
    if (!gitEvidenceSelfHashMatches(result.data)) return { ok: false, reason: `${label} Git evidence's self-referential evidenceHash no longer matches its own content.` };
    return { ok: true };
  }
  const result = persistedFinalGitEnvelopeSchema.safeParse(parsed);
  if (!result.success) return { ok: false, reason: `${label} Git evidence failed strict schema validation and cannot be reviewed: ${result.error.issues[0]?.message ?? "invalid shape"}.` };
  if (!gitEvidenceSelfHashMatches(result.data.evidence)) return { ok: false, reason: `${label} Git evidence's self-referential evidenceHash no longer matches its own content.` };
  if (result.data.delta.finalHash !== result.data.evidence.evidenceHash) return { ok: false, reason: `${label} Git evidence's delta.finalHash does not match its own embedded evidence.` };
  return { ok: true };
}

/**
 * Same distinction as checkGitEvidenceIntegrity, for verification-results
 * JSON: "[]" (well-formed-empty, i.e. no verification operations were
 * required) is legitimate; anything else that fails to parse, is not a JSON
 * array, fails the strict per-result schema (including the PASS-with-
 * nonzero-exit and unknown-operation refinements), or has a resultHash that
 * no longer matches its own content, is a hard failure.
 */
export function checkVerificationEvidenceIntegrity(verificationResultsJson: string): EvidenceIntegrityResult {
  if (verificationResultsJson === "[]") return { ok: true };
  let parsed: unknown;
  try { parsed = JSON.parse(verificationResultsJson); } catch { return { ok: false, reason: "Verification results are not valid JSON and cannot be reviewed." }; }
  if (!Array.isArray(parsed)) return { ok: false, reason: "Verification results are not a JSON array and cannot be reviewed." };
  const result = persistedVerificationResultsSchema.safeParse(parsed);
  if (!result.success) return { ok: false, reason: `Verification results failed strict schema validation and cannot be reviewed: ${result.error.issues[0]?.message ?? "invalid shape"}.` };
  for (const entry of result.data) {
    if (!verificationResultSelfHashMatches(entry)) return { ok: false, reason: "A verification result's resultHash no longer matches its own content." };
  }
  return { ok: true };
}

const EMPTY_GIT_EVIDENCE: ReviewGitEvidenceSummary = {
  available: false, branch: "", head: "", dirty: false, changedFiles: [],
  diffPreview: "", diffTruncated: false, diffOmittedForSensitivePaths: false
};

const DIFF_BOUND_OMISSION_MARKER = "\n...[diff truncated when summarized for review]...\n";

/**
 * Bounds a persisted diff to the GIT_DIFF category budget, cutting only on
 * complete Unicode code points and counting the omission marker toward the
 * result. The previous implementation sliced by UTF-16 code units
 * (`String.prototype.slice`), which both mis-measures the byte cost of any
 * non-ASCII diff and can split a surrogate pair into two lone surrogates.
 */
function boundDiff(text: string): { preview: string; truncated: boolean } {
  const bounded = boundTextToBytes(text, AUTHORITATIVE_REVIEW_MATERIAL_BUDGET.categories.GIT_DIFF.maxIncludedBytes, "HEAD", DIFF_BOUND_OMISSION_MARKER);
  return { preview: bounded.text, truncated: bounded.truncated };
}

/**
 * Parses WorkspaceEvidenceService's persisted `GitEvidence` JSON shape
 * against the strict schema above. Only the well-formed-empty `"{}"` case
 * (this executor produces no Git evidence) ever produces `available: false`
 * -- any other malformed or schema-invalid input THROWS rather than
 * silently degrading to an empty summary. Callers must gate on
 * `checkGitEvidenceIntegrity` first (ReviewEngine.checkEligibility already
 * does, both at request time and at pre-verdict revalidation), so by the
 * time this runs the input is already known-valid; a throw here means that
 * gate was bypassed, which must never happen silently either.
 */
export function summarizeBaselineGitEvidence(baselineEvidenceJson: string): ReviewGitEvidenceSummary {
  if (baselineEvidenceJson === "{}") return EMPTY_GIT_EVIDENCE;
  const evidence = persistedGitEvidenceSchema.parse(JSON.parse(baselineEvidenceJson));
  const bounded = boundDiff(evidence.patchPreview);
  return {
    available: true,
    branch: evidence.branch,
    head: evidence.head,
    dirty: evidence.dirty,
    changedFiles: [],
    diffPreview: bounded.preview,
    diffTruncated: bounded.truncated || evidence.patchTruncated,
    diffOmittedForSensitivePaths: evidence.patchOmittedForSensitivePaths
  };
}

/**
 * Parses the `{ evidence, delta }` shape ExecutionEngine persists into
 * `ExecutionSession.finalEvidenceJson` after a codex-cli run, against the
 * strict schema above. `delta.changedFiles` (baseline/final content-hash
 * presence) is the only signal available -- the capture service performs no
 * rename detection, so a rename surfaces as one deleted path plus one added
 * path, never a single "renamed" entry. Same throw-not-degrade contract as
 * summarizeBaselineGitEvidence.
 */
export function summarizeFinalGitEvidence(finalEvidenceJson: string): ReviewGitEvidenceSummary {
  if (finalEvidenceJson === "{}") return EMPTY_GIT_EVIDENCE;
  const parsed = persistedFinalGitEnvelopeSchema.parse(JSON.parse(finalEvidenceJson));
  const bounded = boundDiff(parsed.evidence.patchPreview);
  const changedFiles = parsed.delta.changedFiles.map(entry => ({
    path: entry.path,
    status: (!entry.preExisting && entry.finalSha256 ? "added" : entry.preExisting && !entry.finalSha256 ? "deleted" : "modified") as "added" | "modified" | "deleted",
    binary: entry.binary
  }));
  return {
    available: true,
    branch: parsed.evidence.branch,
    head: parsed.evidence.head,
    dirty: parsed.evidence.dirty,
    changedFiles,
    diffPreview: bounded.preview,
    diffTruncated: bounded.truncated || parsed.evidence.patchTruncated,
    diffOmittedForSensitivePaths: parsed.evidence.patchOmittedForSensitivePaths
  };
}

/**
 * Parses `ExecutionSession.verificationResultsJson` (VerificationCatalogRunner's
 * `VerificationResult[]`, see relay-v2-execution/src/verification-catalog.ts)
 * against the strict schema above. Same throw-not-degrade contract as the
 * Git evidence summarizers: only `"[]"` (legitimately no verification was
 * required) produces an empty array.
 */
export function summarizeVerificationEvidence(verificationResultsJson: string): ReviewVerificationEvidence[] {
  if (verificationResultsJson === "[]") return [];
  const parsed = persistedVerificationResultsSchema.parse(JSON.parse(verificationResultsJson));
  return parsed.map(entry => ({
    operation: entry.operation,
    displayCommand: entry.displayCommand,
    passed: entry.passed,
    exitCode: entry.exitCode,
    timedOut: entry.timedOut,
    cancelled: entry.cancelled,
    summary: entry.summary,
    stdoutPreview: entry.stdoutPreview,
    stdoutTruncated: entry.stdoutTruncated,
    stderrPreview: entry.stderrPreview,
    stderrTruncated: entry.stderrTruncated,
    runnerOutputTruncated: entry.runnerOutputTruncated,
    runnerStdoutBytes: entry.runnerStdoutBytes,
    runnerStderrBytes: entry.runnerStderrBytes,
    stdoutCapture: entry.stdoutCapture,
    stderrCapture: entry.stderrCapture,
    startedAt: entry.startedAt,
    finishedAt: entry.finishedAt,
    resultHash: entry.resultHash
  }));
}

export type VerificationCaptureCheck = { ok: true } | { ok: false; reason: string };

/**
 * Refuses an AUTHORITATIVE review whose verification evidence cannot be proven
 * to be the output that was actually produced.
 *
 * A PASS never overrides missing evidence. "The command exited 0" and "here is
 * what the command said" are different claims, and a review that cannot see
 * the second is not reviewing the run -- it is trusting an exit code. An
 * unknown loss (TRUNCATED_UNKNOWN) blocks; a KNOWN, fully described truncation
 * of output this runtime held in full does not, because it is disclosed
 * exactly, with the complete stream's hash.
 */
export function checkVerificationCaptureCompleteness(verificationEvidence: readonly ReviewVerificationEvidence[]): VerificationCaptureCheck {
  for (const entry of verificationEvidence) {
    for (const capture of [entry.stdoutCapture, entry.stderrCapture]) {
      if (capture.captureCompleteness !== "TRUNCATED_UNKNOWN") continue;
      return {
        ok: false,
        reason: `Verification operation '${entry.operation}' lost ${capture.stream} output before Relay could record it (capture completeness ${capture.captureCompleteness}${capture.upstreamOmittedByteCount > 0 ? `, ${capture.upstreamOmittedByteCount} byte(s) unrecoverable` : ", loss not attributable to a single stream"}); an AUTHORITATIVE review cannot proceed on output that cannot be proven complete, regardless of the operation's exit status.`
      };
    }
    if (entry.runnerOutputTruncated && entry.stdoutCapture.captureCompleteness === "COMPLETE" && entry.stderrCapture.captureCompleteness === "COMPLETE") {
      return {
        ok: false,
        reason: `Verification operation '${entry.operation}' reports discarded process output while both of its streams claim complete capture; this evidence is internally inconsistent and cannot authorize a review.`
      };
    }
  }
  return { ok: true };
}

// ============================================================================
// Milestone 2.3B fifth corrective pass -- the cryptographic equality edge
// between the artifact bytes and the database projection of the same
// evidence.
//
// Before this pass the two stores were verified independently: artifact bytes
// were size/hash-checked and then DISCARDED, while the rendered evidence came
// from database JSON that vouched for itself with its own embedded hash. A
// self-hash inside mutable JSON proves nothing against an actor who can write
// that JSON -- the hash is simply recomputed after the edit. Nothing tied the
// content shown to Claude to the content whose bytes had been validated.
//
// Here the artifact bytes are the authoritative source: they are parsed
// through the strict versioned schema, canonicalized, and hashed, and the
// database JSON must reduce -- through the SAME canonical semantics -- to a
// byte-identical value before it may be used. Reducing only one side would
// prove nothing, so both sides go through `canonicalEvidenceSemantics`.
// ============================================================================

/** Shared classification, identical to the producer's, so the artifact and database sides can never disagree merely because they classify differently. */
function changedFileStatusOf(entry: { preExisting: boolean; finalSha256: string | null }): "added" | "modified" | "deleted" {
  return !entry.preExisting && entry.finalSha256 ? "added" : entry.preExisting && !entry.finalSha256 ? "deleted" : "modified";
}

function databaseChangedFileEntries(delta: z.infer<typeof persistedGitEvidenceDeltaSchema>) {
  return delta.changedFiles
    .map(entry => ({
      path: entry.path.replace(/\\/g, "/"),
      status: changedFileStatusOf(entry),
      renamedFrom: null,
      binary: entry.binary,
      baselineSha256: entry.baselineSha256,
      finalSha256: entry.finalSha256
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

/** The database projection of FINAL_GIT, reduced to the same canonical semantics the parsed artifact reduces to. */
function databaseFinalGitSemantics(envelope: z.infer<typeof persistedFinalGitEnvelopeSchema>): unknown {
  return {
    branch: envelope.evidence.branch,
    head: envelope.evidence.head,
    clean: envelope.evidence.status.length === 0,
    changedFiles: databaseChangedFileEntries(envelope.delta),
    captureEvidenceHash: envelope.evidence.evidenceHash,
    forbiddenGitMutationSuspected: envelope.delta.forbiddenGitMutationSuspected
  };
}

function databaseChangedFilesSemantics(envelope: z.infer<typeof persistedFinalGitEnvelopeSchema>): unknown {
  return { files: databaseChangedFileEntries(envelope.delta) };
}

function databasePatchSemantics(envelope: z.infer<typeof persistedFinalGitEnvelopeSchema>, baselineHead: string): unknown {
  const unifiedDiff = envelope.evidence.patchPreview;
  // Identical derivation to the producer's (buildPatchArtifact), from the same
  // shared parser: coverage comes from parsed diff FILE HEADERS, never from a
  // substring test that another file's hunk body could satisfy. The two sides
  // must classify identically or the semantic-equality check below would fail
  // for a reason that has nothing to do with storage integrity.
  const parsed = parseRelayPatchPreview(unifiedDiff);
  const headerPaths = parsed.ok ? new Set(parsed.paths) : new Set<string>();
  const covered: string[] = [];
  const omitted: Array<{ path: string; reason: "SENSITIVE_PATH" }> = [];
  for (const entry of databaseChangedFileEntries(envelope.delta)) {
    if (envelope.evidence.patchOmittedForSensitivePaths) omitted.push({ path: entry.path, reason: "SENSITIVE_PATH" });
    else if (headerPaths.has(entry.path)) covered.push(entry.path);
  }
  return {
    patchKind: "FINAL",
    baselineHead,
    finalHead: envelope.evidence.head,
    unifiedDiff,
    coveredPaths: covered.sort((left, right) => left.localeCompare(right)),
    omittedPaths: omitted.sort((left, right) => left.path.localeCompare(right.path))
  };
}

function databaseVerificationSemantics(results: z.infer<typeof persistedVerificationResultsSchema>): unknown {
  return {
    results: results.map(result => ({
      operation: result.operation,
      displayCommand: result.displayCommand,
      status: result.timedOut ? "TIMED_OUT" : result.cancelled ? "CANCELLED" : result.passed ? "PASSED" : "FAILED",
      exitCode: result.exitCode,
      summary: result.summary,
      stdout: result.stdoutPreview,
      stderr: result.stderrPreview,
      runnerOutputTruncated: result.runnerOutputTruncated,
      runnerStdoutBytes: result.runnerStdoutBytes,
      runnerStderrBytes: result.runnerStderrBytes,
      stdoutCapture: result.stdoutCapture,
      stderrCapture: result.stderrCapture,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      resultHash: result.resultHash
    }))
  };
}

/**
 * Requires canonical semantic equality between every validated artifact and
 * the database projection of the same evidence.
 *
 * Either store diverging is a hard failure: artifact bytes edited without the
 * database following, or database JSON rewritten (even into internally valid
 * content with a correctly recomputed self-hash) without the artifact bytes
 * following. Both directions are blocked before any reviewer is invoked.
 */
export function checkArtifactDatabaseEquality(
  parts: readonly ValidatedReviewEvidencePart[],
  baselineEvidenceJson: string,
  finalEvidenceJson: string,
  verificationResultsJson: string
): EvidenceIntegrityResult {
  const finalGitPart = parts.find(part => part.category === "FINAL_GIT");
  const changedFilesPart = parts.find(part => part.category === "CHANGED_FILES");
  const patchPart = parts.find(part => part.category === "PATCH");
  const verificationPart = parts.find(part => part.category === "VERIFICATION");

  if (finalGitPart || changedFilesPart || patchPart) {
    if (finalEvidenceJson === "{}") {
      return { ok: false, reason: "Validated Git evidence artifacts exist but the persisted Git evidence is empty; the artifact store and the database disagree and this review cannot proceed." };
    }
    const envelope = persistedFinalGitEnvelopeSchema.safeParse(JSON.parse(finalEvidenceJson));
    if (!envelope.success) {
      return { ok: false, reason: `Persisted final Git evidence failed strict schema validation during artifact/database equality checking: ${envelope.error.issues[0]?.message ?? "invalid shape"}.` };
    }
    if (finalGitPart && semanticValueHash(databaseFinalGitSemantics(envelope.data)) !== finalGitPart.semanticHash) {
      return { ok: false, reason: "The validated FINAL_GIT artifact and the persisted Git evidence do not describe the same change set; the artifact store and the database have diverged and this review cannot proceed." };
    }
    if (changedFilesPart && semanticValueHash(databaseChangedFilesSemantics(envelope.data)) !== changedFilesPart.semanticHash) {
      return { ok: false, reason: "The validated CHANGED_FILES artifact and the persisted Git evidence do not describe the same changed files; the artifact store and the database have diverged and this review cannot proceed." };
    }
    if (patchPart) {
      let baselineHead = envelope.data.evidence.head;
      if (baselineEvidenceJson !== "{}") {
        const baseline = persistedGitEvidenceSchema.safeParse(JSON.parse(baselineEvidenceJson));
        if (!baseline.success) {
          return { ok: false, reason: `Persisted baseline Git evidence failed strict schema validation during artifact/database equality checking: ${baseline.error.issues[0]?.message ?? "invalid shape"}.` };
        }
        baselineHead = baseline.data.head;
      }
      if (semanticValueHash(databasePatchSemantics(envelope.data, baselineHead)) !== patchPart.semanticHash) {
        return { ok: false, reason: "The validated PATCH artifact and the persisted Git evidence do not describe the same diff; the artifact store and the database have diverged and this review cannot proceed." };
      }
    }
  }

  if (verificationPart) {
    const results = persistedVerificationResultsSchema.safeParse(JSON.parse(verificationResultsJson === "[]" ? "[]" : verificationResultsJson));
    if (!results.success) {
      return { ok: false, reason: `Persisted verification results failed strict schema validation during artifact/database equality checking: ${results.error.issues[0]?.message ?? "invalid shape"}.` };
    }
    if (semanticValueHash(databaseVerificationSemantics(results.data)) !== verificationPart.semanticHash) {
      return { ok: false, reason: "The validated VERIFICATION artifact and the persisted verification results do not agree; the artifact store and the database have diverged and this review cannot proceed." };
    }
  }
  return { ok: true };
}

// ============================================================================
// Milestone 2.3B fourth corrective pass -- category-specific truncation
// policy and total material byte budget. AUTHORITATIVE_EVIDENCE_POLICY above
// was, until this pass, pure documentation: nothing in ReviewEngine actually
// consulted it. checkAuthoritativeMaterialPolicy below is the real
// enforcement, consulted by ReviewEngine at both request time and pre-verdict
// revalidation (never only once) -- any failure here blocks the review
// (ReviewAuthorityError at request time, STALE at revalidation) before any
// verdict is ever produced, and before the reviewer's own material budget
// checks in review-material.ts/claude-cli-reviewer.ts even run.
// ============================================================================

export type EvidenceTruncationClass = "NON_TRUNCATABLE_CRITICAL" | "TRUNCATABLE_CRITICAL_WITH_DISCLOSURE" | "OPTIONAL";

export type EvidenceCategoryPolicy = {
  truncationClass: EvidenceTruncationClass;
  /** Whether a truncated representation of this category may be built from a head+tail sample (vs. a category that is either shown whole or not shown at all). */
  headTailSamplingAllowed: boolean;
  /** True if truncation that cannot be proven to preserve the category's essential meaning must block the review outright, rather than merely being disclosed. */
  blocksReviewWhenImpermissiblyTruncated: boolean;
};

/**
 * Per-category truncation policy for every AUTHORITATIVE_EVIDENCE_POLICY
 * category (plus EXECUTION_LOG, new in this pass). NON_TRUNCATABLE_CRITICAL
 * categories are never truncated in practice today because their Zod schema
 * `.max(...)` bounds make an oversized value a hard parse failure rather than
 * a silent cut (see reviewInputCapsuleSchema/persistedVerificationResultSchema
 * etc.) -- this table makes that guarantee explicit and reviewable rather
 * than incidental. TRUNCATABLE_CRITICAL_WITH_DISCLOSURE categories may be
 * truncated, but only when the specific safety checks below (diff coverage,
 * failure-tail preservation) can prove nothing essential was lost; otherwise
 * the review is blocked rather than shown incomplete evidence. OPTIONAL
 * (currently only EXECUTION_LOG) may always be truncated and disclosed, and
 * never blocks the review.
 */
export const EVIDENCE_CATEGORY_TRUNCATION_POLICY: Readonly<Record<string, EvidenceCategoryPolicy>> = Object.freeze({
  APPROVED_SPEC: Object.freeze({ truncationClass: "NON_TRUNCATABLE_CRITICAL", headTailSamplingAllowed: false, blocksReviewWhenImpermissiblyTruncated: true }),
  CONSTRAINTS: Object.freeze({ truncationClass: "NON_TRUNCATABLE_CRITICAL", headTailSamplingAllowed: false, blocksReviewWhenImpermissiblyTruncated: true }),
  ACCEPTANCE_CRITERIA: Object.freeze({ truncationClass: "NON_TRUNCATABLE_CRITICAL", headTailSamplingAllowed: false, blocksReviewWhenImpermissiblyTruncated: true }),
  VERIFICATION_REQUIREMENTS: Object.freeze({ truncationClass: "NON_TRUNCATABLE_CRITICAL", headTailSamplingAllowed: false, blocksReviewWhenImpermissiblyTruncated: true }),
  CHANGED_FILE_LIST: Object.freeze({ truncationClass: "NON_TRUNCATABLE_CRITICAL", headTailSamplingAllowed: false, blocksReviewWhenImpermissiblyTruncated: true }),
  ARTIFACT_MANIFEST: Object.freeze({ truncationClass: "NON_TRUNCATABLE_CRITICAL", headTailSamplingAllowed: false, blocksReviewWhenImpermissiblyTruncated: true }),
  EXECUTION_SUMMARY: Object.freeze({ truncationClass: "NON_TRUNCATABLE_CRITICAL", headTailSamplingAllowed: false, blocksReviewWhenImpermissiblyTruncated: true }),
  FINAL_GIT_DIFF: Object.freeze({ truncationClass: "TRUNCATABLE_CRITICAL_WITH_DISCLOSURE", headTailSamplingAllowed: false, blocksReviewWhenImpermissiblyTruncated: true }),
  BASELINE_GIT_DIFF: Object.freeze({ truncationClass: "TRUNCATABLE_CRITICAL_WITH_DISCLOSURE", headTailSamplingAllowed: false, blocksReviewWhenImpermissiblyTruncated: false }),
  VERIFICATION_STDOUT: Object.freeze({ truncationClass: "TRUNCATABLE_CRITICAL_WITH_DISCLOSURE", headTailSamplingAllowed: false, blocksReviewWhenImpermissiblyTruncated: true }),
  VERIFICATION_STDERR: Object.freeze({ truncationClass: "TRUNCATABLE_CRITICAL_WITH_DISCLOSURE", headTailSamplingAllowed: false, blocksReviewWhenImpermissiblyTruncated: true }),
  EXECUTION_LOG: Object.freeze({ truncationClass: "OPTIONAL", headTailSamplingAllowed: true, blocksReviewWhenImpermissiblyTruncated: false })
});

/**
 * A truncated final-state diff must still evidence every changed file, or the
 * review is blocked rather than presented with silently missing diff hunks.
 *
 * "Evidences" means a `diff --git`/`---`/`+++`/rename HEADER names the path.
 * It used to mean "the path string appears somewhere in the preview", which a
 * path mentioned only inside ANOTHER file's hunk body satisfied -- so a
 * truncation that dropped a file's diff entirely could still pass this gate on
 * the strength of an unrelated added line that happened to mention it.
 */
export function checkFinalDiffTruncationCoverage(finalGitEvidence: ReviewGitEvidenceSummary): EvidenceIntegrityResult {
  if (!finalGitEvidence.diffTruncated) return { ok: true };
  return checkDiffHeaderCoverage(finalGitEvidence.diffPreview, finalGitEvidence.changedFiles, "truncated");
}

/** Shared exact-header coverage proof for both the persisted-preview and the rendered-material diff checks. */
function checkDiffHeaderCoverage(diff: string, changedFiles: readonly { path: string }[], phrase: string): EvidenceIntegrityResult {
  const parsed = parseRelayPatchPreview(diff);
  if (!parsed.ok) {
    return { ok: false, reason: `The final Git diff was ${phrase} and can no longer be parsed, so it cannot evidence any changed file (${parsed.reason}); this review cannot proceed on unparseable diff evidence.` };
  }
  const covered = new Set(parsed.paths);
  const missing = changedFiles.filter(file => !covered.has(file.path.replace(/\\/g, "/")));
  if (missing.length) {
    return {
      ok: false,
      reason: `The final Git diff was ${phrase} and contains no file header for ${missing.length} changed file(s) (e.g. '${missing[0]!.path}'); this review cannot proceed with incomplete diff evidence.`
    };
  }
  return { ok: true };
}

/**
 * verification-catalog.ts's boundStream truncates a verification stream from
 * the head only (see MAX_STREAM_PREVIEW_BYTES) -- so a truncated stream from
 * a FAILED operation can never be proven to still contain the
 * failure-relevant tail (error output is conventionally at the end). Rather
 * than silently reviewing incomplete failure evidence, this blocks the
 * review outright. A truncated stream from a PASSING operation is not
 * failure-critical and remains acceptable (already disclosed via
 * stdoutTruncated/stderrTruncated).
 */
export function checkVerificationTruncationSafety(verificationEvidence: readonly ReviewVerificationEvidence[]): EvidenceIntegrityResult {
  for (const entry of verificationEvidence) {
    if (!entry.passed && (entry.stdoutTruncated || entry.stderrTruncated)) {
      return {
        ok: false,
        reason: `Verification operation '${entry.operation}' failed and its ${entry.stdoutTruncated ? "stdout" : "stderr"} output was truncated; the failure-relevant tail cannot be proven preserved, so this review cannot proceed with incomplete failure evidence.`
      };
    }
  }
  return { ok: true };
}

/** redactSecrets replaces matched substrings with a short fixed marker, so ordinary text should never shrink by more than a small fraction of its length; a collapse past this ratio signals redaction ate the field's actual meaning, not merely a few secrets within it. */
const CRITICAL_REDACTION_COLLAPSE_RATIO = 0.5;

/**
 * Blocks rather than silently presenting a NON_TRUNCATABLE_CRITICAL text
 * field whose secret redaction removed the bulk of its content -- scoped only
 * to the free-text critical fields (approved spec objective, execution
 * summary, constraints, acceptance criteria), not to Git diff/verification
 * output, which legitimately often contain redacted secret-shaped substrings
 * as part of ordinary evidence and already have their own truncation-safety
 * checks above.
 */
export function checkCriticalRedactionCollapse(capsule: ReviewInputCapsule): EvidenceIntegrityResult {
  const fields: ReadonlyArray<readonly [string, string]> = [
    ["Approved task objective", capsule.taskObjective],
    ["Execution summary", capsule.executionSummary],
    ["Task constraints", capsule.taskConstraints.join("\n")],
    ["Acceptance criteria", capsule.acceptanceCriteria.join("\n")]
  ];
  for (const [label, original] of fields) {
    if (!original.trim()) continue;
    const redacted = redactSecrets(original);
    if (redacted.length < original.length * CRITICAL_REDACTION_COLLAPSE_RATIO) {
      return { ok: false, reason: `${label} lost the majority of its content during secret redaction; presenting it would be misleading incomplete evidence, so this review cannot proceed.` };
    }
  }
  return { ok: true };
}

/**
 * A truncated diff must still evidence every changed file AFTER reviewer-side
 * bounding, not merely before it. Checked against the exact rendered text.
 */
export function checkRenderedDiffCoverage(renderedDiff: string, changedFiles: readonly { path: string }[], reviewerTruncated: boolean): EvidenceIntegrityResult {
  if (!reviewerTruncated) return { ok: true };
  return checkDiffHeaderCoverage(renderedDiff, changedFiles, "truncated for rendering");
}

export type AuthoritativeMaterialPolicyResult =
  | { ok: true; sections: BuiltMaterialSections; ledger: ReviewMaterialLedger; ledgerHash: string; materialHash: string; envelopeByteCount: number }
  | { ok: false; reason: string };

/**
 * The single entry point ReviewEngine consults, at both request time and
 * pre-verdict revalidation, for every AUTHORITATIVE-only material safety
 * check: diff-truncation coverage (on the rendered text), failed-verification
 * truncation safety, critical-field redaction collapse, and the EXACT
 * serialized material byte ledger.
 *
 * The ledger returned here is the one bound into the ReviewRequest and
 * re-proved at finalization -- it is built from the same rendered sections
 * the reviewer will send, so the budget a review was authorized under and the
 * bytes it actually transmits cannot be two different things.
 *
 * Never consulted for a DIAGNOSTIC review -- these are safety layers specific
 * to handing real evidence to an external reviewer CLI, not a general
 * eligibility requirement.
 */
export function checkAuthoritativeMaterialPolicy(
  capsule: ReviewInputCapsule,
  policyPromptText: string,
  reviewedRequestHash: string
): AuthoritativeMaterialPolicyResult {
  // Runner-level output loss is checked BEFORE anything else about the
  // material: a review whose verification output was thrown away above this
  // runtime is not a review that should get as far as being measured.
  const captureCheck = checkVerificationCaptureCompleteness(capsule.verificationEvidence);
  if (!captureCheck.ok) return captureCheck;
  const verificationCheck = checkVerificationTruncationSafety(capsule.verificationEvidence);
  if (!verificationCheck.ok) return verificationCheck;
  const redactionCheck = checkCriticalRedactionCollapse(capsule);
  if (!redactionCheck.ok) return redactionCheck;

  let sections: BuiltMaterialSections;
  try {
    sections = buildReviewMaterialSections(capsule, policyPromptText, reviewedRequestHash);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "Review material sections could not be built." };
  }

  const diffPart = sections.parts.find(part => part.sectionId === "patchEvidence.unifiedDiff");
  const renderedDiff = ((sections.core.patchEvidence as Record<string, unknown>).unifiedDiff ?? "") as string;
  const diffCoverage = checkRenderedDiffCoverage(renderedDiff, capsule.finalGitEvidence.changedFiles, Boolean(diffPart?.reviewerTruncated) || capsule.finalGitEvidence.diffTruncated);
  if (!diffCoverage.ok) return diffCoverage;

  // Per-category content caps, the aggregate ORIGINAL-byte cap, artifact count
  // and per-artifact size -- everything the section rows alone can decide.
  const budgetCheck = enforceMaterialByteLedger(sections.categoryLedger, capsule.executionArtifactManifest.map(artifact => ({ relativePath: artifact.relativePath, byteCount: artifact.byteCount })));
  if (!budgetCheck.ok) return budgetCheck;
  // ...and then the one that actually bounds what the process receives,
  // enforced against the EXACT canonical bytes of the complete envelope --
  // outer framing, manifest, provenance disclosure, and ledger included, none
  // of it approximated from a sum of fragments.
  const envelopeCheck = enforceEnvelopeByteBudget(sections.envelopeByteCount);
  if (!envelopeCheck.ok) return envelopeCheck;

  return {
    ok: true, sections, ledger: sections.ledger, ledgerHash: sections.ledgerHash,
    materialHash: sections.materialHash, envelopeByteCount: sections.envelopeByteCount
  };
}
