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
  /**
   * Required for claude-cli (enforced by CLAUDE_VERDICT_JSON_SCHEMA and
   * re-checked by ClaudeCliReviewer against its own locally-computed
   * reviewMaterialHash/promptHash before a verdict is ever returned to
   * ReviewEngine); optional here only so FakeReviewer -- which renders no
   * material/prompt of this shape at all -- is not forced to invent values.
   */
  reviewedMaterialHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  reviewedPromptHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
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

/** Time-stamped, never-implicitly-trusted authentication signal for a local reviewer CLI. UNKNOWN is distinct from AUTHENTICATED; a stale AUTHENTICATED reading never authorizes a review by itself — the caller must recheck freshness against `expiresAt`. */
export const reviewerAuthenticationStatusSchema = z.enum(["AUTHENTICATED", "UNAUTHENTICATED", "UNKNOWN", "UNAVAILABLE"]);
export type ReviewerAuthenticationStatus = z.infer<typeof reviewerAuthenticationStatusSchema>;

const sha256HexOptionalSchema = z.string().regex(/^([a-f0-9]{64})?$/);

/**
 * Provider-agnostic capability diagnostic for any local-CLI reviewer (Claude
 * CLI today; any future local-CLI reviewer reuses the same shape). Contains no
 * raw executable path, credential, or raw help/auth output — only sanitized,
 * hashed, and time-bounded fields. ReviewEngine persists and re-serves this
 * without needing to know anything reviewer-specific.
 */
export const reviewerCapabilityDiagnosticSchema = z.object({
  reviewerId: z.string().min(1).max(100),
  displayPath: z.string().max(500),
  version: z.string().max(100),
  authenticationStatus: reviewerAuthenticationStatusSchema,
  authenticationEvidence: z.string().min(1).max(100),
  supported: z.boolean(),
  unsupportedReasons: z.array(z.string().max(300)).max(20),
  executableIdentityHash: sha256HexOptionalSchema,
  helpHash: sha256HexOptionalSchema,
  /**
   * Stable identifier for the exact, locally-verified real-CLI JSON transport
   * wrapper shape this reviewer's version-to-wrapper catalog resolved to (see
   * `resolveClaudeWrapperContract`), and the version of this repository's own
   * parser logic for that contract. Empty string when unsupported/unresolved
   * (e.g. an unregistered CLI version) -- never fabricated. Reviewer-agnostic
   * on this shared schema so a future local-CLI reviewer reuses the same
   * shape; a reviewer with no wrapper-contract concept simply always reports
   * empty strings here.
   */
  wrapperContractId: z.string().max(100).default(""),
  wrapperParserVersion: z.string().max(20).default(""),
  detectedAt: z.string().datetime(),
  expiresAt: z.string().datetime()
}).strict();
export type ReviewerCapabilityDiagnostic = z.infer<typeof reviewerCapabilityDiagnosticSchema>;

/**
 * The exact byte sizes of the four things actually built for one reviewer
 * invocation, measured from the built strings themselves.
 *
 * `budgetLedgerJsonBytes` is the serialized size of the material byte ledger
 * as transmitted/persisted. It is reported here rather than inside the ledger
 * because a value cannot contain its own size: adding it to the ledger would
 * change the ledger, and therefore the value.
 *
 * Declared here (rather than alongside the ledger itself in
 * material-ledger.ts) so the invocation record below can reference it without
 * the two modules importing each other.
 */
export const promptAccountingSchema = z.object({
  materialJsonBytes: z.number().int().min(0),
  manifestJsonBytes: z.number().int().min(0),
  budgetLedgerJsonBytes: z.number().int().min(0),
  policyPromptBytes: z.number().int().min(0),
  finalPromptBytes: z.number().int().min(0),
  finalStdinBytes: z.number().int().min(0)
}).strict();
export type PromptAccounting = z.infer<typeof promptAccountingSchema>;

export const EMPTY_PROMPT_ACCOUNTING: PromptAccounting = Object.freeze({
  materialJsonBytes: 0, manifestJsonBytes: 0, budgetLedgerJsonBytes: 0,
  policyPromptBytes: 0, finalPromptBytes: 0, finalStdinBytes: 0
});

/**
 * Durable, append-only forensic record of one real reviewer-process
 * invocation, reported by a RelayReviewer through `ReviewControls.recordInvocation`
 * so ReviewEngine (never the reviewer itself) owns the persistence. Reviewer-
 * agnostic on purpose — a reviewer never touches the database directly.
 */
export const reviewerInvocationRecordSchema = z.object({
  reviewerId: z.string().min(1).max(100),
  capabilitySnapshotId: z.string().uuid().nullable(),
  cliVersion: z.string().max(100),
  executableIdentityHash: sha256HexOptionalSchema,
  materializerVersion: z.string().min(1).max(50),
  promptPolicyVersion: z.string().min(1).max(50),
  wrapperContractId: z.string().max(100),
  wrapperParserVersion: z.string().max(20),
  reviewMaterialHash: z.string().regex(/^[a-f0-9]{64}$/),
  promptHash: z.string().regex(/^[a-f0-9]{64}$/),
  /**
   * The exact material byte ledger, final-stdin identity, and measured byte
   * counts of every string this invocation actually built. Persisted so a
   * verdict can only be accepted after the same values are reconstructed and
   * proven equal -- a reviewer cannot measure one prompt and send another.
   */
  materialBudgetLedgerHash: z.string().regex(/^([a-f0-9]{64})?$/).default(""),
  finalStdinHash: z.string().regex(/^([a-f0-9]{64})?$/).default(""),
  promptAccounting: promptAccountingSchema.default(EMPTY_PROMPT_ACCOUNTING),
  stdoutRedacted: z.string().max(65_536),
  stdoutTruncated: z.boolean(),
  stderrRedacted: z.string().max(65_536),
  stderrTruncated: z.boolean(),
  structuredOutputJson: z.string().nullable(),
  processId: z.number().int().nullable(),
  processIdentity: z.string().nullable(),
  processStartedAt: z.string().datetime().nullable(),
  processFinishedAt: z.string().datetime().nullable(),
  processExitCode: z.number().int().nullable(),
  processSignal: z.string().nullable(),
  timedOut: z.boolean(),
  cancelled: z.boolean()
}).strict();
export type ReviewerInvocationRecord = z.infer<typeof reviewerInvocationRecordSchema>;

/**
 * Milestone 2.3B reviewer configuration for the `claude-cli` reviewer. Every
 * field participates in reviewerConfigHash (and therefore requestHash) — the
 * whole point is that a client can never silently change model, timeout,
 * isolation policy, or which capability snapshot backs a request without
 * creating a brand-new review request. Fields are almost all locked literals
 * on purpose: only what has been locally verified against the real CLI is
 * exposed as configurable at all (currently: nothing beyond the timeout).
 * capabilitySnapshotId/Hash/executableIdentityHash/cliVersion are filled in by
 * the server from a freshly (re)verified ReviewerCapabilityDiagnostic — never
 * accepted from client input — so a request is always bound to one concrete,
 * identity-checked local installation.
 */
export const claudeReviewerConfigSchema = z.object({
  reviewerId: z.literal("claude-cli"),
  model: z.literal("AUTO"),
  reasoningOrEffort: z.literal("AUTO"),
  timeoutSeconds: z.number().int().min(30).max(1_800),
  outputSchemaVersion: z.literal("claude-verdict-v1"),
  materializerVersion: z.literal("claude-materializer-v1"),
  promptPolicyVersion: z.literal("claude-prompt-policy-v1"),
  /**
   * The exact, locally-verified real-CLI JSON transport wrapper contract
   * (and this repository's parser version for it) this request is bound to,
   * sourced from the server's freshly (re)verified capability diagnostic --
   * never accepted from client input. A capability refresh that resolves to
   * a different contract or parser version (a CLI update, or a deployment
   * remapping the same version string to a different verified contract)
   * changes reviewerConfigHash and therefore requestHash, so an existing
   * ReviewRequest can never be silently reused across a contract change; and
   * the live pre-spawn check independently re-verifies these two fields
   * still match immediately before every real invocation.
   */
  wrapperContractId: z.string().min(1).max(100),
  wrapperParserVersion: z.string().min(1).max(20),
  capabilitySnapshotId: z.string().uuid(),
  capabilitySnapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
  executableIdentityHash: z.string().regex(/^[a-f0-9]{64}$/),
  cliVersion: z.string().min(1).max(100),
  readOnlyPolicy: z.literal("DENY_ALL_TOOLS"),
  toolPolicy: z.literal("TOOLS_EMPTY_STRING"),
  configurationIsolationPolicy: z.literal("SAFE_MODE_STRICT_MCP_NO_SESSION_NO_SLASH_COMMANDS"),
  artifactSelectionPolicy: z.literal("BOUND_CAPSULE_ONLY"),
  maximumInputBytes: z.number().int().min(1_000).max(2_000_000),
  maximumOutputBytes: z.number().int().min(1_000).max(2_000_000),
  /**
   * The exact AUTHORITATIVE_REVIEW_MATERIAL_BUDGET version this request's
   * material was assembled and checked against -- sourced from the server's
   * own constant, never accepted from client input. A future change to the
   * budget's limits bumps this literal, which changes reviewerConfigHash and
   * therefore requestHash, so an existing ReviewRequest can never be silently
   * reinterpreted under a different budget.
   */
  materialBudgetVersion: z.literal("material-budget-v1")
}).strict();
export type ClaudeReviewerConfig = z.infer<typeof claudeReviewerConfigSchema>;
export const CLAUDE_CLI_REVIEWER_ID = "claude-cli" as const;

/**
 * One entry in the deterministic manifest of every evidence item selected
 * into a reviewer's rendered material. `omissionReason` is set (and
 * `includedByteCount`/`contentHash` become 0/empty) when a would-be item was
 * deliberately left out (not applicable to this executor, exceeded the
 * per-item budget, etc.) -- an omission is always explicit, never silent.
 */
/**
 * How a truncated manifest item's included bytes were selected from its
 * original content. "NONE" for an item that was not truncated at all.
 */
export const truncationMethodSchema = z.enum(["NONE", "HEAD", "TAIL", "HEAD_AND_TAIL"]);
export type TruncationMethod = z.infer<typeof truncationMethodSchema>;

export const reviewMaterialManifestEntrySchema = z.object({
  itemId: z.string().min(1).max(200),
  itemType: z.enum([
    "TASK_SPEC", "BASELINE_GIT_EVIDENCE", "FINAL_GIT_EVIDENCE", "VERIFICATION_RESULT",
    "EXECUTION_SUMMARY", "EXECUTION_CAPSULE", "EXECUTION_ARTIFACT", "EXECUTION_LOG"
  ]),
  logicalPath: z.string().max(500),
  contentHash: z.string().regex(/^([a-f0-9]{64})?$/),
  originalByteCount: z.number().int().min(0),
  includedByteCount: z.number().int().min(0),
  /**
   * Bytes present in the original evidence but not selected into
   * includedByteCount -- always originalByteCount - includedByteCount for a
   * truncated item, 0 otherwise. Disclosed explicitly (not left for a
   * consumer to compute) so a truncation's real cost is never buried.
   */
  omittedByteCount: z.number().int().min(0),
  truncated: z.boolean(),
  truncationMethod: truncationMethodSchema,
  redactionApplied: z.boolean(),
  encoding: z.enum(["utf8", "none"]),
  omissionReason: z.string().max(300).optional()
}).strict();
export type ReviewMaterialManifestEntry = z.infer<typeof reviewMaterialManifestEntrySchema>;

/**
 * One entry per rendered fragment, so the bound is the capsule's own field
 * bounds summed, not a round number: 100 constraints + 100 acceptance criteria
 * + 3 fragments per verification operation (10) + the fixed spec/diff/log
 * fragments. 200 was below that, which made a legitimate capsule with a full
 * constraint and acceptance-criteria list unrenderable.
 */
export const reviewMaterialManifestSchema = z.array(reviewMaterialManifestEntrySchema).max(500);
export type ReviewMaterialManifest = z.infer<typeof reviewMaterialManifestSchema>;

/**
 * The single, coordinated byte budget for everything an AUTHORITATIVE review
 * assembles and sends to a real reviewer CLI. Every limit here is derived
 * from, and never looser than, a pre-existing cap already enforced somewhere
 * else in the pipeline (see the per-field comments) -- this const formalizes
 * those into one place that can be reasoned about, tested, and versioned
 * together, rather than each layer silently enforcing its own limit with no
 * aggregate accounting. `budgetVersion` is bound into
 * ClaudeReviewerConfig.materialBudgetVersion (and therefore into
 * reviewerConfigHash/requestHash): a future change to any limit here forces a
 * brand-new review request rather than silently reinterpreting an existing
 * one under a different budget.
 */
export const AUTHORITATIVE_REVIEW_MATERIAL_BUDGET = Object.freeze({
  budgetVersion: "material-budget-v1",
  /** Sum of every category's originalByteCount, before any truncation. */
  maxTotalOriginalBytes: 6_000_000,
  /** Sum of every category's includedByteCount, i.e. what is actually rendered into the material JSON. Matches ClaudeReviewerConfig.maximumInputBytes's ceiling. */
  maxTotalIncludedBytes: 500_000,
  /** Matches reviewInputCapsuleSchema.executionArtifactManifest's own .max(200). */
  maxArtifactCount: 200,
  /** Matches artifact-evidence.ts's MAX_ARTIFACT_BYTES. */
  maxBytesPerArtifact: 16 * 1024 * 1024,
  /** Ceiling on the fully rendered Claude prompt text (policy header + material JSON), before the echo-hash lines are spliced in. */
  maxPromptBytes: 600_000,
  /** Ceiling on the exact final bytes written to the reviewer CLI's stdin (prompt plus echo lines), re-checked immediately before spawning. */
  maxFinalStdinBytes: 700_000,
  categories: Object.freeze({
    APPROVED_SPEC: Object.freeze({ maxOriginalBytes: 60_000, maxIncludedBytes: 60_000 }),
    CONSTRAINTS: Object.freeze({ maxOriginalBytes: 200_000, maxIncludedBytes: 200_000 }),
    ACCEPTANCE_CRITERIA: Object.freeze({ maxOriginalBytes: 200_000, maxIncludedBytes: 200_000 }),
    /** Matches review-binding.ts's MAX_DIFF_PREVIEW_CHARS (100,000 chars, UTF-8 bytes >= chars). */
    GIT_DIFF: Object.freeze({ maxOriginalBytes: 400_000, maxIncludedBytes: 100_000 }),
    CHANGED_FILE_METADATA: Object.freeze({ maxOriginalBytes: 100_000, maxIncludedBytes: 100_000 }),
    /** 10 verification ops (reviewInputCapsuleSchema's own cap) * verification-catalog.ts's MAX_STREAM_PREVIEW_BYTES (16,384). */
    VERIFICATION_STDOUT: Object.freeze({ maxOriginalBytes: 163_840, maxIncludedBytes: 163_840 }),
    VERIFICATION_STDERR: Object.freeze({ maxOriginalBytes: 163_840, maxIncludedBytes: 163_840 }),
    /** Sourced from the LOG execution artifact; original may be as large as ExecutionArtifactStore's maxLogBytes (5 MiB default), head+tail sampled down to a small included budget. */
    EXECUTION_LOG: Object.freeze({ maxOriginalBytes: 5 * 1024 * 1024, maxIncludedBytes: 32_768 }),
    EXECUTION_SUMMARY: Object.freeze({ maxOriginalBytes: 20_000, maxIncludedBytes: 20_000 }),
    ARTIFACT_MANIFEST: Object.freeze({ maxOriginalBytes: 100_000, maxIncludedBytes: 100_000 }),
    REVIEWER_POLICY_PROMPT: Object.freeze({ maxOriginalBytes: 20_000, maxIncludedBytes: 20_000 })
  })
});
export type AuthoritativeReviewMaterialBudget = typeof AUTHORITATIVE_REVIEW_MATERIAL_BUDGET;
export type AuthoritativeReviewMaterialCategory = keyof typeof AUTHORITATIVE_REVIEW_MATERIAL_BUDGET.categories;

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
