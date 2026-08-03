import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson, hashTaskSpec, reviewAuthoritySchema, reviewerSelectionSchema, type NormalizedTaskSpec, type ReviewAuthority } from "@project-relay/relay-v2-domain";

const sha256Pattern = /^[a-f0-9]{64}$/;

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
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
export const reviewInputCapsuleSchema = z.object({
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
  reviewPolicyVersion: z.string().min(1).max(50)
}).strict();
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
