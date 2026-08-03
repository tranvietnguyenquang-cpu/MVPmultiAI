import { z } from "zod";

export const reviewRequestStatusSchema = z.enum([
  "PENDING", "CLAIMED", "RUNNING", "CANCELLATION_REQUESTED",
  "APPROVED", "REJECTED", "NEEDS_CHANGES", "ERROR", "CANCELLED", "STALE"
]);
export type ReviewRequestStatus = z.infer<typeof reviewRequestStatusSchema>;

export const TERMINAL_REVIEW_STATUSES = Object.freeze([
  "APPROVED", "REJECTED", "NEEDS_CHANGES", "ERROR", "CANCELLED", "STALE"
] as const satisfies readonly ReviewRequestStatus[]);

/**
 * PENDING may cancel straight to CANCELLED (nothing is running yet, so there is
 * no finalization race to guard against). Once a runtime host has claimed a
 * row, cancellation must pass through CANCELLATION_REQUESTED so it can race a
 * verdict via a CAS update instead of a plain write.
 */
export const REVIEW_TRANSITIONS: Readonly<Record<ReviewRequestStatus, readonly ReviewRequestStatus[]>> = Object.freeze({
  PENDING: ["CLAIMED", "CANCELLED", "STALE", "ERROR"],
  CLAIMED: ["RUNNING", "CANCELLATION_REQUESTED", "ERROR", "STALE"],
  RUNNING: ["CANCELLATION_REQUESTED", "APPROVED", "REJECTED", "NEEDS_CHANGES", "ERROR", "STALE"],
  CANCELLATION_REQUESTED: ["CANCELLED", "ERROR", "STALE"],
  APPROVED: [],
  REJECTED: [],
  NEEDS_CHANGES: [],
  ERROR: [],
  CANCELLED: [],
  STALE: []
});

export class InvalidReviewTransitionError extends Error {
  constructor(readonly from: ReviewRequestStatus, readonly to: ReviewRequestStatus) {
    super(`Review request cannot transition from ${from} to ${to}.`);
    this.name = "InvalidReviewTransitionError";
  }
}

export function isTerminalReviewStatus(status: ReviewRequestStatus): boolean {
  return (TERMINAL_REVIEW_STATUSES as readonly string[]).includes(status);
}

export function canTransitionReview(from: ReviewRequestStatus, to: ReviewRequestStatus): boolean {
  return REVIEW_TRANSITIONS[from].includes(to);
}

export function assertReviewTransition(from: ReviewRequestStatus, to: ReviewRequestStatus): void {
  if (!canTransitionReview(from, to)) throw new InvalidReviewTransitionError(from, to);
}

export const reviewEventTypeSchema = z.enum([
  "REVIEW_REQUESTED",
  "REVIEW_ELIGIBILITY_REJECTED",
  "REVIEW_CLAIMED",
  "REVIEW_STARTED",
  "REVIEWER_OUTPUT_RECEIVED",
  "REVIEW_APPROVED",
  "REVIEW_REJECTED",
  "REVIEW_NEEDS_CHANGES",
  "REVIEW_ERROR",
  "REVIEW_CANCELLATION_REQUESTED",
  "REVIEW_CANCELLED",
  "REVIEW_STALE_INVALIDATED",
  "REVIEW_EVIDENCE_RECHECKED",
  "REVIEW_STALE_LEASE_RECOVERED"
]);
export type ReviewEventType = z.infer<typeof reviewEventTypeSchema>;

export const reviewEventLevelSchema = z.enum(["DEBUG", "INFO", "WARNING", "ERROR"]);
export type ReviewEventLevel = z.infer<typeof reviewEventLevelSchema>;

export const findingSeveritySchema = z.enum(["BLOCKER", "HIGH", "MEDIUM", "LOW", "INFO"]);
export type FindingSeverity = z.infer<typeof findingSeveritySchema>;

export const reviewFindingSchema = z.object({
  id: z.string().trim().min(1).max(100),
  severity: findingSeveritySchema,
  category: z.string().trim().min(1).max(100),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(4_000),
  evidenceReferences: z.array(z.string().trim().min(1).max(500)).max(50).default([]),
  requiredAction: z.string().trim().max(2_000).optional(),
  blocking: z.boolean()
}).strict();
export type ReviewFinding = z.infer<typeof reviewFindingSchema>;

export const reviewVerdictValueSchema = z.enum(["APPROVE", "REJECT", "NEEDS_CHANGES"]);
export type ReviewVerdictValue = z.infer<typeof reviewVerdictValueSchema>;

/**
 * The reviewer's free-form summary text has no authority; only these validated
 * fields (and the invariants below) determine what the verdict means.
 */
export const structuredReviewVerdictSchema = z.object({
  reviewedRequestHash: z.string().regex(/^[a-f0-9]{64}$/),
  verdict: reviewVerdictValueSchema,
  summary: z.string().trim().min(1).max(10_000),
  findings: z.array(reviewFindingSchema).max(100).default([]),
  requiredActions: z.array(z.string().trim().min(1).max(2_000)).max(50).default([]),
  confidence: z.number().min(0).max(1).default(1),
  reviewerVersion: z.string().trim().min(1).max(100)
}).strict().superRefine((verdict, ctx) => {
  const blockingHighOrBlocker = verdict.findings.some(finding => finding.blocking && (finding.severity === "BLOCKER" || finding.severity === "HIGH"));
  const anyBlocking = verdict.findings.some(finding => finding.blocking);
  if (verdict.verdict === "APPROVE" && blockingHighOrBlocker) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["findings"], message: "APPROVE cannot contain a blocking BLOCKER or HIGH finding." });
  }
  if (verdict.verdict === "REJECT" && !anyBlocking) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["findings"], message: "REJECT must contain at least one blocking finding." });
  }
  if (verdict.verdict === "NEEDS_CHANGES" && verdict.requiredActions.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["requiredActions"], message: "NEEDS_CHANGES must contain at least one required action." });
  }
});
export type StructuredReviewVerdict = z.infer<typeof structuredReviewVerdictSchema>;

export const reviewerProviderTypeSchema = z.enum(["FAKE", "LOCAL_CLI", "API"]);
export type ReviewerProviderType = z.infer<typeof reviewerProviderTypeSchema>;

export const reviewerDescriptorSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{1,49}$/),
  displayName: z.string().min(1).max(100),
  providerType: reviewerProviderTypeSchema,
  readOnly: z.literal(true),
  structuredOutput: z.literal(true),
  cancellationSupport: z.boolean(),
  capabilities: z.array(z.string().min(1).max(100))
}).strict();
export type ReviewerDescriptor = z.infer<typeof reviewerDescriptorSchema>;

export const fakeReviewerOutcomeSchema = z.enum(["approve", "reject", "needs_changes", "invalid", "failure", "cancellation"]);
export type FakeReviewerOutcome = z.infer<typeof fakeReviewerOutcomeSchema>;

export const fakeReviewerScenarioSchema = z.object({
  outcome: fakeReviewerOutcomeSchema.default("approve"),
  delayMs: z.number().int().min(0).max(10_000).default(0),
  summary: z.string().trim().min(1).max(4_000).default("Fake review completed."),
  findings: z.array(reviewFindingSchema).max(20).default([]),
  requiredActions: z.array(z.string().trim().min(1).max(2_000)).max(20).default([])
}).strict();
export type FakeReviewerScenario = z.infer<typeof fakeReviewerScenarioSchema>;

export const reviewPolicyVersionSchema = z.literal("2.3A-v1");
export const REVIEW_POLICY_VERSION = "2.3A-v1" as const;

/**
 * DIAGNOSTIC verdicts (currently: every FakeReviewer verdict) are displayable
 * but can never satisfy a future auto-commit gate. There is no implicit
 * upgrade path from DIAGNOSTIC to AUTHORITATIVE.
 */
export const reviewAuthoritySchema = z.enum(["AUTHORITATIVE", "DIAGNOSTIC"]);
export type ReviewAuthority = z.infer<typeof reviewAuthoritySchema>;

/** Coarse, externally-facing review lifecycle state. CLAIMED and CANCELLATION_REQUESTED both project as RUNNING: from a caller's perspective the review is simply "in flight, not yet resolved." */
export const reviewGateStateSchema = z.enum([
  "NOT_REQUESTED", "PENDING", "RUNNING", "APPROVED", "REJECTED", "NEEDS_CHANGES", "ERROR", "CANCELLED", "STALE"
]);
export type ReviewGateState = z.infer<typeof reviewGateStateSchema>;

/** NONE only when no review request exists yet for the session; otherwise the review's assigned reviewAuthority. */
export const reviewGateAuthoritySchema = z.enum(["NONE", "AUTHORITATIVE", "DIAGNOSTIC"]);
export type ReviewGateAuthority = z.infer<typeof reviewGateAuthoritySchema>;

/**
 * Authority-preserving projection of a review onto its execution session.
 * Replaces a lossy plain-string status: every consumer (API responses, UI)
 * must render `authority` alongside `state` so a DIAGNOSTIC APPROVE is never
 * displayed or reasoned about as an unqualified approval. Never a stored
 * execution field — always derived fresh from the latest ReviewRequest.
 */
export const reviewGateProjectionSchema = z.object({
  state: reviewGateStateSchema,
  authority: reviewGateAuthoritySchema,
  reviewerId: z.string().nullable(),
  reviewRequestId: z.string().uuid().nullable(),
  verdictId: z.string().uuid().nullable(),
  requestHash: z.string().nullable(),
  /**
   * Milestone 2.3A has no auto-commit policy: always false. A future
   * milestone may set this once an explicit commit policy exists — until
   * then nothing may derive commit authority from a review, diagnostic or
   * otherwise. See canSatisfyAuthoritativeReviewGate.
   */
  commitAuthorityEligible: z.boolean()
}).strict();
export type ReviewGateProjection = z.infer<typeof reviewGateProjectionSchema>;

/**
 * The single centralized gate for any future commit/auto-accept policy.
 * Milestone 2.3A has no such policy, so this always returns false —
 * regardless of state, authority, or a caller-supplied
 * commitAuthorityEligible flag — so no caller can authorize a commit from a
 * review (diagnostic or authoritative) using only `verdict === APPROVE`.
 * A later milestone must replace this implementation deliberately, not by
 * callers reading verdict/authority themselves.
 */
export function canSatisfyAuthoritativeReviewGate(projection: ReviewGateProjection): boolean {
  void projection;
  return false;
}
