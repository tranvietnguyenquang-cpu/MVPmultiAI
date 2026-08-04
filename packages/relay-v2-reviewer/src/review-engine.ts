import { randomUUID } from "node:crypto";
import { redactSecrets } from "@project-relay/local-safety";
import {
  MATERIAL_BUDGET_POLICY_VERSION,
  REVIEW_POLICY_VERSION,
  assertReviewTransition,
  canonicalJson,
  claudeReviewerConfigSchema,
  fakeReviewerScenarioSchema,
  isTerminalReviewStatus,
  reviewAuthoritySchema,
  reviewerCapabilityDiagnosticSchema,
  reviewerInvocationRecordSchema,
  reviewRequestStatusSchema,
  reviewerSelectionSchema,
  structuredReviewVerdictSchema,
  type ReviewAuthority,
  type ReviewerCapabilityDiagnostic,
  type ReviewEventLevel,
  type ReviewEventType,
  type ReviewGateProjection,
  type ReviewGateState,
  type ReviewerInvocationRecord,
  type ReviewRequestStatus,
  type StructuredReviewVerdict
} from "@project-relay/relay-v2-domain";
import { Prisma, type RelayV2Database } from "@project-relay/relay-v2-persistence";
import { z } from "zod";
import { SystemReviewClock, type ReviewClock } from "./clock.js";
import {
  assertAuthoritativeLogProvenance,
  assertProducerTruncationPolicy,
  checkConditionalEvidenceRequirements,
  LOG_PROVENANCE_ARTIFACT_MISMATCH,
  REQUIRED_ARTIFACT_TYPES_FOR_AUTHORITATIVE_REVIEW,
  validateRequiredArtifacts,
  type ValidatedLogEvidencePart,
  type ValidatedReviewEvidencePart
} from "./artifact-evidence.js";
import {
  checkArtifactDatabaseEquality,
  checkAuthoritativeMaterialPolicy,
  checkGitEvidenceIntegrity,
  checkVerificationCaptureCompleteness,
  checkVerificationEvidenceIntegrity,
  computeCanonicalTaskSpecHash,
  computeRequestHash,
  computeReviewInputHash,
  computeTaskNormalizedSpecHash,
  reviewInputCapsuleSchema,
  sha256Hex,
  summarizeBaselineGitEvidence,
  summarizeExecutionLogEvidence,
  summarizeFinalGitEvidence,
  summarizeVerificationEvidence,
  verifyCapsuleIntegrity,
  verifyJsonHashBinding,
  type ReviewInputCapsule
} from "./review-binding.js";
import { compareInvocationIdentity, prepareReviewInvocation, preparedInvocationIdentity } from "./prepared-invocation.js";
import { resolveReviewerAuthority } from "./reviewer-authority.js";
import type { ImmutableReviewCapsule, PreparedReviewInvocation, RelayReviewer } from "./reviewer-contract.js";
import { ReviewerRegistry } from "./reviewer-registry.js";

/**
 * Every value that can affect RelayReviewer.review()'s behavior must be bound
 * by a schema here, keyed by reviewerId, so it participates in
 * reviewerConfigHash. Any reviewer id with no entry gets the strictest
 * possible schema (no configuration permitted at all) — a future reviewer
 * must deliberately register its own schema before it can accept any config.
 */
const REVIEWER_CONFIG_SCHEMA_BY_ID: Record<string, z.ZodTypeAny> = {
  "fake-reviewer": fakeReviewerScenarioSchema,
  "claude-cli": claudeReviewerConfigSchema
};
function reviewerConfigSchemaFor(reviewerId: string): z.ZodTypeAny {
  return REVIEWER_CONFIG_SCHEMA_BY_ID[reviewerId] ?? z.object({}).strict();
}

export class ReviewAuthorityError extends Error {}
export class ReviewConflictError extends Error {}
export class ReviewNotFoundError extends Error {}

const ACTIVE_REVIEW_STATUSES: readonly ReviewRequestStatus[] = ["PENDING", "CLAIMED", "RUNNING", "CANCELLATION_REQUESTED"];

const reviewInclude = {
  verdicts: { orderBy: { createdAt: "asc" as const } },
  events: { orderBy: { sequence: "asc" as const } }
};

const sessionInclude = {
  task: { include: { approvals: { orderBy: { resolvedAt: "desc" as const } } } },
  artifacts: { orderBy: { relativePath: "asc" as const } },
  leases: { orderBy: { acquiredAt: "desc" as const } }
};

type SessionWithReviewContext = Prisma.ExecutionSessionGetPayload<{ include: typeof sessionInclude }>;
type ApprovalRow = SessionWithReviewContext["task"]["approvals"][number];
type ArtifactRow = { id: string; sessionId: string; artifactType: string; relativePath: string; sha256: string; byteCount: number; truncated: boolean };
type ReviewRequestRow = Prisma.ReviewRequestGetPayload<Record<string, never>>;

export type ReviewRequestDetails = Prisma.ReviewRequestGetPayload<{ include: typeof reviewInclude }>;

export type ReviewEngineOptions = {
  clock?: ReviewClock;
  eventPreviewBytes?: number;
  leaseMs?: number;
  /**
   * Milestone 2.3A restriction: a FakeExecutor session may only be reviewed when
   * both this engine-level flag AND the caller's explicit `diagnostic: true` are
   * set, keeping diagnostic-only review paths out of any production runtime.
   */
  allowFakeExecutorDiagnosticReviews?: boolean;
  /**
   * A separately-gated diagnostic path that lets FakeReviewer review a
   * codex-cli (including Codex test-double) session. Only for the disposable
   * Playwright browser-test environment; never on in a normal or production
   * runtime, and never AUTHORITATIVE even when on.
   */
  allowCodexTestDoubleDiagnosticReviews?: boolean;
  /**
   * Canonical, application-owned execution-artifact storage root (mirrors
   * ExecutionArtifactStore.artifactsRoot). When set, every codex-cli
   * session's recorded ExecutionArtifact rows are byte-validated against the
   * real files on disk (ownership, path containment, hash, size) before a
   * review may proceed, and every artifact type
   * REQUIRED_ARTIFACT_TYPES_FOR_AUTHORITATIVE_REVIEW expects is required to
   * be present. Left unset only by tests that fabricate database rows
   * without real artifact files; production always sets this.
   */
  artifactsRoot?: string;
};

export type RequestReviewOptions = {
  reviewerConfig?: unknown;
  diagnostic?: boolean;
};

export type RequestReviewResult = { reviewRequest: ReviewRequestDetails; duplicate: boolean };

/** The ownership generation a runtime host proved when it claimed a review. Every terminal write must re-prove this exact generation still holds. */
type ClaimOwnership = { ownerId: string; leaseToken: string; claimAttempt: number };

/** Terminal (and PREPARING) invocation lifecycle states; see ReviewInvocation's migration comment for the full rationale. */
type InvocationStatus = "PREPARING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "TIMED_OUT" | "CANCELLED" | "OWNERSHIP_LOST" | "INTERRUPTED_UNCERTAIN";

/** Thrown by createOwnedInvocationOrThrow when the claiming ownership generation no longer holds; the caller must never invoke the reviewer in this case. */
class InvocationOwnershipLostError extends Error {}

/**
 * Why an authoritative reconstruction refused, and therefore how it is
 * persisted. The split is deliberate and load-bearing:
 *   - EVIDENCE_CHANGED is STALE: the world moved, which is not an error;
 *   - everything else is ERROR: a configuration/IO failure, or a persisted
 *     authority state that is malformed or impossible, neither of which may
 *     be filed away as ordinary drift.
 * Neither ever triggers an automatic rerun.
 */
type AuthoritativeFailureCode =
  | "EVIDENCE_CHANGED"
  | "REVIEW_IMMUTABLE_INPUT_MISMATCH"
  | "ARTIFACT_STORE_UNAVAILABLE"
  | "ARTIFACT_STORE_READ_FAILURE"
  /** The artifact row and the producer's LOG provenance are each valid but describe different streams -- never STALE: nothing changed, the two accounts simply contradict each other. */
  | typeof LOG_PROVENANCE_ARTIFACT_MISMATCH
  | "INVOCATION_BINDING_MISMATCH"
  | "REVIEWER_ECHO_MISMATCH";

/** The codes that describe the world changing, rather than something being wrong: these become STALE, everything else ERROR. */
const STALE_FAILURE_CODES: ReadonlySet<AuthoritativeFailureCode> = Object.freeze(new Set<AuthoritativeFailureCode>(["EVIDENCE_CHANGED"]));

function isUniqueFailure(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function finalBranchHead(finalEvidenceJson: string): { branch: string; head: string } {
  if (finalEvidenceJson === "{}") return { branch: "", head: "" };
  try {
    const parsed = JSON.parse(finalEvidenceJson) as { evidence?: { branch?: unknown; head?: unknown } };
    const branch = typeof parsed.evidence?.branch === "string" ? parsed.evidence.branch : "";
    const head = typeof parsed.evidence?.head === "string" ? parsed.evidence.head : "";
    return { branch, head };
  } catch {
    return { branch: "", head: "" };
  }
}

function artifactSetHash(artifacts: readonly ArtifactRow[]): string {
  const projected = artifacts
    .map(artifact => ({ artifactType: artifact.artifactType, relativePath: artifact.relativePath, sha256: artifact.sha256, byteCount: artifact.byteCount, truncated: artifact.truncated }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return sha256Hex(canonicalJson(projected));
}

const outcomeStatusByExecutionStatus: Record<string, string> = {
  SUCCEEDED: "succeeded", FAILED: "failed", TIMED_OUT: "timed_out", CANCELLED: "cancelled", BLOCKED: "blocked"
};

const terminalByVerdict = { APPROVE: "APPROVED", REJECT: "REJECTED", NEEDS_CHANGES: "NEEDS_CHANGES" } as const;
const eventByVerdict = { APPROVE: "REVIEW_APPROVED", REJECT: "REVIEW_REJECTED", NEEDS_CHANGES: "REVIEW_NEEDS_CHANGES" } as const;

/** Every column that gets cleared when a lease-owning review reaches any terminal state. */
const RELEASED_LEASE_FIELDS = { ownerId: null, leaseToken: null, claimedAt: null, heartbeatAt: null, leaseExpiresAt: null } as const;

/** CLAIMED and CANCELLATION_REQUESTED both project as RUNNING: externally, the review is simply "in flight". */
const GATE_STATE_BY_REQUEST_STATUS: Record<ReviewRequestStatus, ReviewGateState> = {
  PENDING: "PENDING", CLAIMED: "RUNNING", RUNNING: "RUNNING", CANCELLATION_REQUESTED: "RUNNING",
  APPROVED: "APPROVED", REJECTED: "REJECTED", NEEDS_CHANGES: "NEEDS_CHANGES", ERROR: "ERROR", CANCELLED: "CANCELLED", STALE: "STALE"
};

export class ReviewEngine {
  readonly reviewers: ReviewerRegistry;
  private readonly clock: ReviewClock;
  private readonly eventPreviewBytes: number;
  private readonly leaseMs: number;
  private readonly allowFakeExecutorDiagnosticReviews: boolean;
  private readonly allowCodexTestDoubleDiagnosticReviews: boolean;
  private readonly artifactsRoot: string | undefined;
  private readonly controllers = new Map<string, AbortController>();

  constructor(
    private readonly database: RelayV2Database,
    reviewers: RelayReviewer | readonly RelayReviewer[] | ReviewerRegistry,
    options: ReviewEngineOptions = {}
  ) {
    this.reviewers = reviewers instanceof ReviewerRegistry ? reviewers : new ReviewerRegistry(Array.isArray(reviewers) ? reviewers : [reviewers as RelayReviewer]);
    this.clock = options.clock ?? new SystemReviewClock();
    this.eventPreviewBytes = options.eventPreviewBytes ?? 4_096;
    this.leaseMs = options.leaseMs ?? 15_000;
    this.allowFakeExecutorDiagnosticReviews = options.allowFakeExecutorDiagnosticReviews ?? false;
    this.allowCodexTestDoubleDiagnosticReviews = options.allowCodexTestDoubleDiagnosticReviews ?? false;
    this.artifactsRoot = options.artifactsRoot;
  }

  private boundedPayload(payload: unknown): string {
    const redacted = redactSecrets(canonicalJson(payload));
    if (Buffer.byteLength(redacted, "utf8") <= this.eventPreviewBytes) return redacted;
    return canonicalJson({ truncated: true, preview: redacted.slice(0, Math.max(0, this.eventPreviewBytes - 100)) });
  }

  private async appendEventTx(tx: Prisma.TransactionClient, reviewRequestId: string, eventType: ReviewEventType, level: ReviewEventLevel, message: string, payload: unknown = {}) {
    const latest = await tx.reviewEvent.findFirst({ where: { reviewRequestId }, orderBy: { sequence: "desc" }, select: { sequence: true } });
    return tx.reviewEvent.create({ data: {
      id: randomUUID(), reviewRequestId, sequence: (latest?.sequence ?? 0) + 1, eventType, level,
      message: redactSecrets(message).slice(0, 2_000), payloadJson: this.boundedPayload(payload)
    } });
  }

  private async appendEvent(reviewRequestId: string, eventType: ReviewEventType, level: ReviewEventLevel, message: string, payload: unknown = {}) {
    await this.database.$transaction(tx => this.appendEventTx(tx, reviewRequestId, eventType, level, message, payload));
  }

  /** Session-level eligibility only. Reviewer-authority matching is a separate, independently re-run decision (see resolveReviewerAuthority). */
  private async checkEligibility(session: SessionWithReviewContext): Promise<{ reason: string } | null> {
    if (session.status !== "SUCCEEDED") return { reason: `Execution session status is ${session.status}; only a succeeded execution can be reviewed.` };
    if (session.task.status !== "AWAITING_USER_ACCEPTANCE") return { reason: `Task status is ${session.task.status}; the execution has not reached AWAITING_USER_ACCEPTANCE.` };
    if (session.leases.some(lease => !lease.releasedAt)) return { reason: "The workspace lease for this execution has not been released." };
    // Malformed non-empty persisted evidence must never be silently absorbed
    // into an "unavailable"/empty summary further down this pipeline
    // (summarizeBaselineGitEvidence/summarizeFinalGitEvidence/
    // summarizeVerificationEvidence all degrade a parse/shape failure that
    // way) -- it is a hard eligibility failure here, before any capsule is
    // ever built, for every executor and every review authority.
    const baselineIntegrity = checkGitEvidenceIntegrity(session.baselineEvidenceJson, "Baseline", "baseline");
    if (!baselineIntegrity.ok) return { reason: baselineIntegrity.reason };
    const finalIntegrity = checkGitEvidenceIntegrity(session.finalEvidenceJson, "Final", "final");
    if (!finalIntegrity.ok) return { reason: finalIntegrity.reason };
    const verificationIntegrity = checkVerificationEvidenceIntegrity(session.verificationResultsJson);
    if (!verificationIntegrity.ok) return { reason: verificationIntegrity.reason };
    if (session.executorId === "codex-cli") {
      if (!session.capsuleHash) return { reason: "Execution capsule is missing." };
      if (session.baselineEvidenceJson === "{}") return { reason: "Baseline Git evidence is missing." };
      if (session.finalEvidenceJson === "{}") return { reason: "Final Git evidence is missing." };
    }
    const verificationOperations = JSON.parse(session.approvedVerificationJson) as unknown[];
    if (verificationOperations.length && session.verificationResultsJson === "[]") return { reason: "Verification results are missing." };
    if (!session.artifacts.length) return { reason: "No execution artifacts have been recorded." };
    if (!verifyCapsuleIntegrity(session.capsuleJson, session.capsuleHash)) return { reason: "The execution capsule failed integrity verification." };
    return null;
  }

  /**
   * The AUTHORITATIVE-only artifact-store gate (Milestone 2.3B fourth
   * corrective pass): an AUTHORITATIVE review can never proceed without a
   * configured, readable, byte-validated artifact store -- absence or a read
   * failure both block before the reviewer is ever invoked, and are reported
   * distinctly from ordinary evidence drift (the caller maps this to ERROR,
   * never STALE/EVIDENCE_CHANGED, and never silently skips validation the way
   * the old bare `if (this.artifactsRoot)` gate did). A DIAGNOSTIC review has
   * no such requirement and always succeeds trivially with no log content.
   * Never reads the live project or Relay workspace as a fallback -- only the
   * application-owned artifact store this engine was configured with.
   */
  private async validateAuthoritativeArtifactEvidence(
    session: SessionWithReviewContext, authorityMode: ReviewAuthority
  ): Promise<
    | { ok: true; log: ValidatedLogEvidencePart | null; parts: ValidatedReviewEvidencePart[] }
    | { ok: false; reason: string; code: "ARTIFACT_STORE_UNAVAILABLE" | "ARTIFACT_STORE_READ_FAILURE" | typeof LOG_PROVENANCE_ARTIFACT_MISMATCH }
  > {
    if (authorityMode !== "AUTHORITATIVE") return { ok: true, log: null, parts: [] };
    if (!this.artifactsRoot) {
      return { ok: false, code: "ARTIFACT_STORE_UNAVAILABLE", reason: "This runtime has no execution-artifact storage root configured; an AUTHORITATIVE review requires byte-validated artifact evidence and cannot proceed." };
    }
    // VERIFICATION is only ever written when verification operations were
    // actually approved for this task (see ExecutionEngine.runClaimed) --
    // requiring it unconditionally would wrongly block every codex-cli
    // session approved with zero verification operations.
    const verificationOperations = JSON.parse(session.approvedVerificationJson) as unknown[];
    const requiredTypes = REQUIRED_ARTIFACT_TYPES_FOR_AUTHORITATIVE_REVIEW.filter(type => type !== "VERIFICATION" || verificationOperations.length > 0);
    const artifactCheck = await validateRequiredArtifacts(this.artifactsRoot, session.id, session.artifacts, requiredTypes);
    // A row/provenance contradiction is reported under its own code rather
    // than as an ordinary read failure: nothing is unreadable or missing, two
    // valid records of the same log simply disagree.
    if (!artifactCheck.ok) return { ok: false, code: artifactCheck.code ?? "ARTIFACT_STORE_READ_FAILURE", reason: artifactCheck.reason };

    // The artifact bytes are the authoritative source. Everything below runs
    // against the parsed, byte-validated parts -- never against the database
    // projection on its own.
    const truncationPolicy = assertProducerTruncationPolicy(artifactCheck.parts);
    if (!truncationPolicy.ok) return { ok: false, code: "ARTIFACT_STORE_READ_FAILURE", reason: truncationPolicy.reason };
    // The producer's LOG provenance is required, and required to describe the
    // real bytes, at EVERY point this runs: request eligibility, pre-spawn
    // reconstruction, and finalization. A missing, empty, unknown-completeness,
    // or self-contradicting provenance blocks here -- before a ReviewRequest
    // exists, before any ReviewInvocation is created, and before any Claude
    // process is started.
    const logProvenance = assertAuthoritativeLogProvenance(artifactCheck.log);
    if (!logProvenance.ok) {
      return { ok: false, code: "code" in logProvenance ? logProvenance.code : "ARTIFACT_STORE_READ_FAILURE", reason: logProvenance.reason };
    }
    const conditional = checkConditionalEvidenceRequirements(artifactCheck.parts);
    if (!conditional.ok) return { ok: false, code: "ARTIFACT_STORE_READ_FAILURE", reason: conditional.reason };
    // The one cryptographic equality edge: the database JSON that will be
    // rendered must reduce, through the same canonical semantics, to exactly
    // what the validated artifact bytes say. Divergence in EITHER store is a
    // hard block before any reviewer is invoked.
    const equality = checkArtifactDatabaseEquality(artifactCheck.parts, session.baselineEvidenceJson, session.finalEvidenceJson, session.verificationResultsJson);
    if (!equality.ok) return { ok: false, code: "ARTIFACT_STORE_READ_FAILURE", reason: equality.reason };

    return { ok: true, log: artifactCheck.log, parts: artifactCheck.parts };
  }

  /** The reviewer's own policy header, charged to the REVIEWER_POLICY_PROMPT budget category rather than counted as zero. */
  private policyPromptFor(reviewerId: string): string {
    return this.reviewers.get(reviewerId)?.materialPolicyPrompt?.() ?? "";
  }

  /** Independently re-derives the specHash embedded in the approval snapshot and requires it to match the frozen taskSpecHash column — never trusts approvedSpecHash in isolation. */
  private specIntegrityFailure(session: SessionWithReviewContext, approval: ApprovalRow): { reason: string } | null {
    if (computeCanonicalTaskSpecHash(approval.approvedSpecJson) !== session.approvedSpecHash) {
      return { reason: "The task specification failed integrity verification." };
    }
    return null;
  }

  /**
   * Assembles the complete ReviewInputCapsule from current source-of-truth
   * rows. Pure and DB-free: callers pass in a session/approval already read
   * either outside a transaction (request time) or inside one (revalidation),
   * so this never itself decides what "current" means.
   */
  /** Throwing wrapper for the request-time paths, where a capsule that cannot be built is a hard authority failure. */
  private buildReviewInputCapsuleOrThrow(
    reviewRequestId: string, requestedAt: Date, session: SessionWithReviewContext, projectId: string,
    reviewerId: string, approval: ApprovalRow, reviewAuthority: ReviewAuthority, diagnostic: boolean,
    executionLog: ValidatedLogEvidencePart | null
  ): ReviewInputCapsule {
    const result = this.buildReviewInputCapsule(reviewRequestId, requestedAt, session, projectId, reviewerId, approval, reviewAuthority, diagnostic, executionLog);
    if (!result.ok) throw new ReviewAuthorityError(result.reason);
    return result.capsule;
  }

  private buildReviewInputCapsule(
    reviewRequestId: string, requestedAt: Date, session: SessionWithReviewContext, projectId: string,
    reviewerId: string, approval: ApprovalRow, reviewAuthority: ReviewAuthority, diagnostic: boolean,
    executionLog: ValidatedLogEvidencePart | null
  ): { ok: true; capsule: ReviewInputCapsule } | { ok: false; reason: string } {
    const { branch, head } = finalBranchHead(session.finalEvidenceJson);
    let normalizedSpec: { constraints: string[]; acceptanceCriteria: string[] };
    try {
      const parsed = JSON.parse(session.task.normalizedSpecJson) as { constraints?: unknown; acceptanceCriteria?: unknown };
      normalizedSpec = {
        constraints: Array.isArray(parsed.constraints) ? parsed.constraints.filter((value): value is string => typeof value === "string") : [],
        acceptanceCriteria: Array.isArray(parsed.acceptanceCriteria) ? parsed.acceptanceCriteria.filter((value): value is string => typeof value === "string") : []
      };
    } catch {
      normalizedSpec = { constraints: [], acceptanceCriteria: [] };
    }
    let approvedVerificationOperations: unknown[] = [];
    try {
      const parsedOps: unknown = JSON.parse(session.approvedVerificationJson);
      if (Array.isArray(parsedOps)) approvedVerificationOperations = parsedOps;
    } catch { /* left empty */ }
    // Rendered from the ONE validated LOG evidence object -- bytes, records,
    // and the producer's own provenance together. Nothing here reads the
    // artifact row's `truncated` column or any other partial substitute for
    // that provenance. Strict UTF-8 decoding and record validation can
    // legitimately fail (binary or corrupted bytes); that is reported, never
    // absorbed into an empty transcript that would read as "this run produced
    // no output".
    const executionLogEvidence = summarizeExecutionLogEvidence(executionLog);
    if (!executionLogEvidence.ok) return { ok: false, reason: executionLogEvidence.reason };
    // Last gate before the capsule becomes the authoritative binding: an
    // AUTHORITATIVE capsule may never be built around a log whose producer
    // provenance is absent. validateAuthoritativeArtifactEvidence already
    // refused this case; proving it again here means no future caller can
    // assemble an authoritative capsule that quietly lost it.
    if (reviewAuthority === "AUTHORITATIVE" && executionLogEvidence.evidence.producerProvenance === null) {
      return { ok: false, reason: "The execution log evidence bound into this AUTHORITATIVE review carries no producer provenance; the review cannot proceed." };
    }
    const capsule = reviewInputCapsuleSchema.parse({
      reviewRequestId, executionSessionId: session.id, projectId, taskId: session.taskId, reviewerId, reviewAuthority, diagnostic,
      approvalId: approval.id, approvalStatus: approval.status,
      approvedReviewer: reviewerSelectionSchema.parse(approval.reviewer),
      taskSelectedReviewer: reviewerSelectionSchema.parse(session.task.reviewer),
      executionExecutorId: session.executorId,
      taskTitle: session.task.title, taskObjective: session.task.objective, taskContext: session.task.context,
      taskSpecHash: session.approvedSpecHash,
      canonicalTaskSpecHash: computeCanonicalTaskSpecHash(approval.approvedSpecJson),
      taskNormalizedSpecHash: computeTaskNormalizedSpecHash(session.task.normalizedSpecJson),
      approvalSnapshotHash: sha256Hex(approval.approvedSpecJson),
      executionStatus: session.status,
      executionResultStatus: outcomeStatusByExecutionStatus[session.status] ?? session.status.toLowerCase(),
      executionSummary: session.summary, executionSummaryHash: sha256Hex(session.summary),
      executionCapsuleHash: session.capsuleHash ?? sha256Hex("{}"),
      executionCapsuleJsonHash: sha256Hex(session.capsuleJson),
      baselineGitEvidenceHash: sha256Hex(session.baselineEvidenceJson),
      finalGitEvidenceHash: sha256Hex(session.finalEvidenceJson),
      verificationResultsHash: sha256Hex(session.verificationResultsJson),
      executionArtifactSetHash: artifactSetHash(session.artifacts),
      finalBranch: branch, finalHead: head,
      requestedAt: requestedAt.toISOString(), reviewPolicyVersion: REVIEW_POLICY_VERSION,
      taskConstraints: normalizedSpec.constraints,
      acceptanceCriteria: normalizedSpec.acceptanceCriteria,
      approvedExecutorSelection: session.approvedExecutor,
      approvedModel: session.approvedModel,
      approvedEffort: session.approvedEffort,
      approvedVerificationOperations,
      baselineGitEvidence: summarizeBaselineGitEvidence(session.baselineEvidenceJson),
      finalGitEvidence: summarizeFinalGitEvidence(session.finalEvidenceJson),
      verificationEvidence: summarizeVerificationEvidence(session.verificationResultsJson),
      executionArtifactManifest: session.artifacts.map(artifact => ({
        artifactId: artifact.id, artifactType: artifact.artifactType, relativePath: artifact.relativePath,
        sha256: artifact.sha256, byteCount: artifact.byteCount, truncated: artifact.truncated
      })),
      executionLogEvidence: executionLogEvidence.evidence
    });
    return { ok: true, capsule };
  }

  /**
   * Atomically creates the single ReviewInvocation row for this request
   * (schema-enforced UNIQUE on reviewRequestId), durably coupling it to the
   * exact ownership/lease/claim generation that is about to invoke the
   * reviewer -- one transaction, re-proving the full ownership predicate
   * (mirrors ownershipWhere) AND requiring no invocation already exists,
   * both inside the same transaction as the insert. If either predicate
   * fails, no row is inserted, and the caller (runClaimed) must never call
   * reviewer.review(): a stale or superseded owner, or a request that
   * (should never happen, but is checked regardless) already has an
   * invocation, can never start a second Claude/reviewer process.
   */
  private async createOwnedInvocationOrThrow(
    reviewRequestId: string, reviewerId: string, ownership: ClaimOwnership,
    prepared: PreparedReviewInvocation | null, capabilitySnapshotId: string | null,
    wrapperContract: { contractId: string; parserVersion: string } | null
  ): Promise<string> {
    return this.database.$transaction(async tx => {
      const now = this.clock.now();
      const current = await tx.reviewRequest.findUnique({ where: { id: reviewRequestId } });
      if (!current || current.status !== "RUNNING" || current.ownerId !== ownership.ownerId || current.leaseToken !== ownership.leaseToken || current.claimAttempts !== ownership.claimAttempt || !current.leaseExpiresAt || current.leaseExpiresAt <= now) {
        throw new InvocationOwnershipLostError("Review lease ownership was lost before the invocation could be created.");
      }
      const existing = await tx.reviewInvocation.findUnique({ where: { reviewRequestId } });
      if (existing) throw new Error("A ReviewInvocation already exists for this review request; a second invocation attempt is not permitted.");
      const id = randomUUID();
      const createdAt = now;
      // Bound only when the referenced snapshot actually exists: a capability
      // snapshot id that no row matches is a dangling reference, and inserting
      // it would fail the foreign key and lose the whole invocation rather
      // than simply recording that no snapshot was resolvable.
      const boundSnapshotId = capabilitySnapshotId
        && await tx.reviewerCapabilitySnapshot.findUnique({ where: { id: capabilitySnapshotId }, select: { id: true } })
        ? capabilitySnapshotId
        : null;
      await tx.reviewInvocation.create({ data: {
        id, reviewRequestId, reviewerId, status: "PREPARING",
        ownerId: ownership.ownerId, claimAttempt: ownership.claimAttempt, createdAt, updatedAt: createdAt,
        // The complete transmitted identity, committed HERE -- before the
        // process exists, not patched in after it exits. A row that has not
        // reached this point describes nothing, and a verdict can only ever be
        // accepted against an identity that was durable before the reviewer
        // was given anything to read.
        ...(prepared ? {
          capabilitySnapshotId: boundSnapshotId,
          wrapperContractId: wrapperContract?.contractId ?? "",
          wrapperParserVersion: wrapperContract?.parserVersion ?? "",
          materialEnvelopeVersion: prepared.materialEnvelopeVersion,
          materialBudgetPolicyVersion: prepared.materialBudgetPolicyVersion,
          materialBudgetLedgerJson: prepared.ledgerJson,
          materialBudgetLedgerHash: prepared.ledgerHash,
          reviewMaterialHash: prepared.materialHash,
          exactMaterialEnvelopeByteCount: prepared.materialByteCount,
          promptPolicyVersion: prepared.promptPolicyVersion,
          promptHash: prepared.promptHash,
          finalPromptByteCount: prepared.finalPromptByteCount,
          finalStdinHash: prepared.finalStdinHash,
          finalStdinByteCount: prepared.finalStdinByteCount,
          promptAccountingJson: canonicalJson(prepared.promptAccounting)
        } : {})
      } });
      return id;
    });
  }

  /** Ownership-scoped CAS predicate shared by every non-transition-specific ReviewInvocation write: only the still-live owning generation that created the row may update it, and only while it is still PREPARING or RUNNING (never overwriting an already-terminal row). RUNNING is included because markInvocationRunning may already have transitioned the row by the time the reviewer reports its final detail/terminal status. */
  private invocationOwnershipWhere(reviewRequestId: string, ownership: ClaimOwnership) {
    return { reviewRequestId, ownerId: ownership.ownerId, claimAttempt: ownership.claimAttempt, status: { in: ["PREPARING", "RUNNING"] } };
  }

  /**
   * CAS-transitions the single ReviewInvocation row from PREPARING to RUNNING
   * the instant the reviewer's owned process actually starts, persisting the
   * exact process identity durably. Requires, in one transaction: the
   * invocation id, reviewRequestId, ownerId, and claimAttempt to all still
   * match the invocation row (still PREPARING), AND the owning ReviewRequest
   * to still be RUNNING under this exact ownerId/leaseToken/claimAttempts
   * generation with an unexpired lease. Returns false (never throws) if any
   * of that no longer holds -- the caller (ClaudeCliReviewer, via
   * ReviewControls.markInvocationRunning) must then treat this exactly like
   * a lost heartbeat: stop treating the invocation as authoritative and let
   * the aborted signal terminate the owned process.
   */
  private async markInvocationRunning(reviewRequestId: string, invocationId: string, ownership: ClaimOwnership, processInfo: { pid: number; processIdentity: string; startedAt: string }): Promise<boolean> {
    return this.database.$transaction(async tx => {
      const now = this.clock.now();
      const request = await tx.reviewRequest.findUnique({ where: { id: reviewRequestId } });
      if (!request || request.status !== "RUNNING" || request.ownerId !== ownership.ownerId || request.leaseToken !== ownership.leaseToken || request.claimAttempts !== ownership.claimAttempt || !request.leaseExpiresAt || request.leaseExpiresAt <= now) {
        return false;
      }
      const updated = await tx.reviewInvocation.updateMany({
        where: { id: invocationId, reviewRequestId, ownerId: ownership.ownerId, claimAttempt: ownership.claimAttempt, status: "PREPARING" },
        data: { status: "RUNNING", processId: processInfo.pid, processIdentity: processInfo.processIdentity, processStartedAt: new Date(processInfo.startedAt) }
      });
      return updated.count === 1;
    });
  }

  /**
   * CAS-updates the single ReviewInvocation row to a terminal status, but
   * only if it is still PREPARING under the exact ownership generation that
   * created it -- if the reviewer itself already updated the row to a
   * terminal status via recordInvocation (as ClaudeCliReviewer always does
   * before throwing or returning), this matches zero rows and is a no-op; it
   * exists to guarantee every invocation attempt ends in a terminal status
   * even for a reviewer that never calls recordInvocation at all (e.g.
   * FakeReviewer) or that fails before ever reaching that call (e.g. a
   * pre-spawn capability/identity mismatch). Never creates a row: if none
   * exists (createOwnedInvocationOrThrow never succeeded), this is a no-op.
   */
  private async finalizeInvocationStatus(reviewRequestId: string, ownership: ClaimOwnership, status: Exclude<InvocationStatus, "PREPARING" | "RUNNING">): Promise<void> {
    await this.database.reviewInvocation.updateMany({
      where: this.invocationOwnershipWhere(reviewRequestId, ownership),
      data: { status }
    });
  }

  private deriveInvocationStatusFromRecord(record: ReviewerInvocationRecord): Exclude<InvocationStatus, "PREPARING" | "RUNNING" | "OWNERSHIP_LOST" | "INTERRUPTED_UNCERTAIN"> {
    if (record.cancelled) return "CANCELLED";
    if (record.timedOut) return "TIMED_OUT";
    if (record.structuredOutputJson && record.processExitCode === 0) return "SUCCEEDED";
    return "FAILED";
  }

  /**
   * CAS-updates the single ReviewInvocation row in place with one
   * reviewer-reported invocation detail report, redacted and bounded, only if
   * it is still PREPARING under the exact ownership generation that created
   * it. Never invented by ReviewEngine itself — only ever what the reviewer
   * explicitly reported via `ReviewControls.recordInvocation`. Its `status`
   * is derived deterministically from the record's own
   * cancelled/timedOut/exitCode/output fields (never a separate claim), so
   * `finalizeInvocationStatus` sees the row already terminal and skips its
   * own fallback update. If ownership was lost (0 rows matched), this is a
   * silent no-op here -- the ReviewRequest-level CAS elsewhere is what
   * ultimately reports ownership loss for the request as a whole.
   */
  private async persistReviewerInvocation(reviewRequestId: string, ownership: ClaimOwnership, record: ReviewerInvocationRecord): Promise<void> {
    const parsed = reviewerInvocationRecordSchema.parse(record);
    // The transmitted identity is WRITE-ONCE, bound before the process
    // started, so this report can only ever add process detail to it -- never
    // restate it. A reviewer that reports different identities than it was
    // given is an integrity violation, not a correction to apply: it is
    // refused here, and the review ends without a verdict.
    const bound = await this.database.reviewInvocation.findUnique({ where: { reviewRequestId } });
    if (bound?.reviewMaterialHash) {
      const mismatched = (
        bound.reviewMaterialHash !== parsed.reviewMaterialHash ? "reviewMaterialHash"
          : bound.promptHash !== parsed.promptHash ? "promptHash"
            : bound.materialBudgetLedgerHash !== parsed.materialBudgetLedgerHash ? "materialBudgetLedgerHash"
              : bound.finalStdinHash !== parsed.finalStdinHash ? "finalStdinHash" : null
      );
      if (mismatched) {
        throw new Error(`The reviewer reported a ${mismatched} that differs from the one durably bound to this invocation before its process started; the result cannot be trusted.`);
      }
    }
    await this.database.reviewInvocation.updateMany({
      where: this.invocationOwnershipWhere(reviewRequestId, ownership),
      data: {
        status: this.deriveInvocationStatusFromRecord(parsed),
        cliVersion: parsed.cliVersion, executableIdentityHash: parsed.executableIdentityHash,
        materializerVersion: parsed.materializerVersion,
        stdoutRedacted: redactSecrets(parsed.stdoutRedacted), stdoutTruncated: parsed.stdoutTruncated,
        stderrRedacted: redactSecrets(parsed.stderrRedacted), stderrTruncated: parsed.stderrTruncated,
        structuredOutputJson: parsed.structuredOutputJson,
        processId: parsed.processId, processIdentity: parsed.processIdentity,
        processStartedAt: parsed.processStartedAt ? new Date(parsed.processStartedAt) : null,
        processFinishedAt: parsed.processFinishedAt ? new Date(parsed.processFinishedAt) : null,
        processExitCode: parsed.processExitCode, processSignal: parsed.processSignal,
        timedOut: parsed.timedOut, cancelled: parsed.cancelled
      }
    });
  }

  /**
   * True if the (at most one, per the schema's UNIQUE constraint) invocation
   * for any (non-cancelled) ReviewRequest belonging to this execution session
   * is still non-terminal or ended INTERRUPTED_UNCERTAIN -- i.e. a prior
   * Claude (or other real-CLI) process's termination was never proven. While
   * quarantined, a new AUTHORITATIVE-capable review request for this session
   * is refused entirely (see requestReview) rather than risking a second
   * concurrent process against the same evidence.
   */
  private async hasUnresolvedInvocation(executionSessionId: string): Promise<boolean> {
    const requests = await this.database.reviewRequest.findMany({ where: { executionSessionId }, select: { id: true } });
    if (!requests.length) return false;
    const unresolved = await this.database.reviewInvocation.findFirst({
      where: { reviewRequestId: { in: requests.map(request => request.id) }, status: { in: ["PREPARING", "RUNNING", "INTERRUPTED_UNCERTAIN"] } },
      select: { id: true }
    });
    return unresolved !== null;
  }

  /**
   * Mirrors ExecutionEngine.refreshExecutorCapabilities: if the registered
   * reviewer supports capability re-discovery, run it and persist a new,
   * append-only ReviewerCapabilitySnapshot row. ReviewEngine never knows how
   * discovery works (no process-spawning code here) — it only persists and
   * re-serves whatever the reviewer reports.
   */
  async refreshReviewerCapabilities(reviewerId: string): Promise<{ descriptor: ReturnType<RelayReviewer["describe"]>; health: Awaited<ReturnType<RelayReviewer["health"]>>; snapshot: ReviewerCapabilityDiagnostic | null; snapshotId: string | null }> {
    const reviewer = this.reviewers.require(reviewerId);
    if (!reviewer.refreshCapabilities) return { descriptor: reviewer.describe(), health: await reviewer.health(), snapshot: null, snapshotId: null };
    const diagnostic = reviewerCapabilityDiagnosticSchema.parse(await reviewer.refreshCapabilities());
    const snapshotId = randomUUID();
    await this.database.reviewerCapabilitySnapshot.create({ data: {
      id: snapshotId, reviewerId, displayPath: diagnostic.displayPath, version: diagnostic.version,
      authenticationStatus: diagnostic.authenticationStatus, supported: diagnostic.supported,
      snapshotJson: this.boundedPayload(diagnostic), helpHash: diagnostic.helpHash || sha256Hex(""), detectedAt: new Date(diagnostic.detectedAt)
    } });
    return { descriptor: reviewer.describe(), health: await reviewer.health(), snapshot: diagnostic, snapshotId };
  }

  /** Latest persisted capability snapshot for a reviewer, or null if none has ever been recorded. Purely informational: never itself the authorization gate for a real review (the reviewer re-verifies live at review time). */
  async latestReviewerCapability(reviewerId: string): Promise<ReviewerCapabilityDiagnostic | null> {
    return (await this.latestReviewerCapabilityRecord(reviewerId))?.diagnostic ?? null;
  }

  /** Row id of the latest persisted capability snapshot for a reviewer, or null. Kept only for existing callers that need the id alone; prefer latestReviewerCapabilityRecord when both id and diagnostic are needed together (see its docstring for why). */
  async latestReviewerCapabilitySnapshotId(reviewerId: string): Promise<string | null> {
    return (await this.latestReviewerCapabilityRecord(reviewerId))?.id ?? null;
  }

  /**
   * Atomically reads the id and diagnostic content of the latest persisted
   * capability snapshot from a single row in one query. Milestone 2.3B's
   * original implementation called latestReviewerCapability (one query) and
   * latestReviewerCapabilitySnapshotId (a second, separate query) back to
   * back; a capability refresh racing between those two queries could pair
   * an id from one snapshot with diagnostic content from a different one,
   * and buildClaudeReviewerConfig would then bind a request to a
   * capabilitySnapshotId whose actual stored content never matched what was
   * used to build the config. This method is the only correct way to obtain
   * both together.
   */
  async latestReviewerCapabilityRecord(reviewerId: string): Promise<{ id: string; diagnostic: ReviewerCapabilityDiagnostic } | null> {
    const stored = await this.database.reviewerCapabilitySnapshot.findFirst({ where: { reviewerId }, orderBy: { detectedAt: "desc" } });
    if (!stored) return null;
    const parsed = reviewerCapabilityDiagnosticSchema.safeParse(JSON.parse(stored.snapshotJson));
    return parsed.success ? { id: stored.id, diagnostic: parsed.data } : null;
  }

  /** `failureCode` is recorded when the refusal has a specific one, so an audit trail says WHICH invariant refused, not merely that something did. The reason is bounded and carries no artifact path or log content. */
  private async auditRejected(session: SessionWithReviewContext, projectId: string, actor: string, reason: string, failureCode?: AuthoritativeFailureCode) {
    await this.database.auditEvent.create({ data: {
      id: randomUUID(), projectId, taskId: session.taskId, executionSessionId: session.id, actor,
      action: "REVIEW_REQUEST_REJECTED", riskLevel: "REVIEW",
      detailsJson: this.boundedPayload(failureCode ? { reason, failureCode } : { reason })
    } });
  }

  async requestReview(executionSessionId: string, projectId: string, reviewerId: string, actor = "local-user", options: RequestReviewOptions = {}): Promise<RequestReviewResult> {
    const reviewer = this.reviewers.get(reviewerId);
    if (!reviewer) throw new ReviewAuthorityError(`Reviewer '${reviewerId}' is not registered in this runtime.`);

    const session = await this.database.executionSession.findUnique({ where: { id: executionSessionId }, include: sessionInclude });
    if (!session || session.projectId !== projectId) throw new ReviewNotFoundError("Execution session not found for this project.");

    const activeExisting = await this.database.reviewRequest.findFirst({ where: { executionSessionId, status: { in: [...ACTIVE_REVIEW_STATUSES] } }, include: reviewInclude });
    if (activeExisting) return { reviewRequest: activeExisting, duplicate: true };

    // A prior real-CLI reviewer invocation whose process termination was
    // never proven (runtime restart, or a heartbeat/lease loss the process
    // may not have actually honored) must never be joined by a second
    // concurrent invocation against the same evidence. FakeReviewer never
    // spawns a process, so it is exempt from this quarantine.
    if (reviewer.id !== "fake-reviewer" && (await this.hasUnresolvedInvocation(executionSessionId))) {
      await this.auditRejected(session, projectId, actor, "A prior reviewer invocation for this execution session has not been proven to have terminated; a new authoritative review cannot start until that is resolved.");
      throw new ReviewAuthorityError("This execution session is quarantined: a prior reviewer invocation's termination could not be proven.");
    }

    const eligibilityFailure = await this.checkEligibility(session);
    if (eligibilityFailure) {
      await this.auditRejected(session, projectId, actor, eligibilityFailure.reason);
      throw new ReviewAuthorityError(eligibilityFailure.reason);
    }

    const approval = session.task.approvals.find(item => item.specHash === session.approvedSpecHash);
    if (!approval) {
      await this.auditRejected(session, projectId, actor, "The approval snapshot used for this execution could not be found.");
      throw new ReviewAuthorityError("The approval snapshot used for this execution could not be found.");
    }

    const specIntegrity = this.specIntegrityFailure(session, approval);
    if (specIntegrity) {
      await this.auditRejected(session, projectId, actor, specIntegrity.reason);
      throw new ReviewAuthorityError(specIntegrity.reason);
    }

    const diagnosticRequested = options.diagnostic === true;
    const authority = resolveReviewerAuthority({
      requestedReviewerId: reviewerId,
      approvalStatus: approval.status,
      approvalReviewerSelection: reviewerSelectionSchema.parse(approval.reviewer),
      taskSelectedReviewer: reviewerSelectionSchema.parse(session.task.reviewer),
      executionExecutorId: session.executorId,
      diagnosticRequested,
      allowFakeExecutorDiagnosticReviews: this.allowFakeExecutorDiagnosticReviews,
      allowCodexTestDoubleDiagnosticReviews: this.allowCodexTestDoubleDiagnosticReviews
    });
    if (!authority.authorized) {
      await this.auditRejected(session, projectId, actor, authority.reason);
      throw new ReviewAuthorityError(authority.reason);
    }

    // AUTHORITATIVE-only artifact-store gate (Milestone 2.3B fourth
    // corrective pass): absence or a read failure both block here, before any
    // ReviewRequest row is created and long before the reviewer is ever
    // invoked. A DIAGNOSTIC review is unaffected.
    const artifactEvidence = await this.validateAuthoritativeArtifactEvidence(session, authority.mode);
    if (!artifactEvidence.ok) {
      await this.auditRejected(session, projectId, actor, artifactEvidence.reason, artifactEvidence.code);
      throw new ReviewAuthorityError(artifactEvidence.reason);
    }

    const reviewRequestId = randomUUID();
    const requestedAt = this.clock.now();

    // Evidence-content safety (lost verification output, unsafe truncation,
    // redaction collapse) depends only on the capsule and is checked here,
    // where a failure can be audited as a rejected request. The exact material
    // envelope cannot be built yet: it embeds `reviewedRequestHash`, and
    // requestHash binds an attempt number that is only known atomically inside
    // the transaction below.
    if (authority.mode === "AUTHORITATIVE") {
      const previewCapsule = this.buildReviewInputCapsuleOrThrow(reviewRequestId, requestedAt, session, projectId, reviewerId, approval, authority.mode, diagnosticRequested, artifactEvidence.log);
      const captureCheck = checkVerificationCaptureCompleteness(previewCapsule.verificationEvidence);
      if (!captureCheck.ok) {
        await this.auditRejected(session, projectId, actor, captureCheck.reason);
        throw new ReviewAuthorityError(captureCheck.reason);
      }
    }

    // The reviewer's own configuration is authority-affecting input (for
    // FakeReviewer it directly determines approve/reject/needs_changes/
    // failure/delay/cancellation outcomes), so it is validated with the
    // reviewer's own schema, canonicalized, and hashed — never appended
    // unbound alongside the evidence capsule.
    const reviewerConfigParsed: unknown = reviewerConfigSchemaFor(reviewer.id).parse(options.reviewerConfig ?? {});
    const reviewerConfigJson = canonicalJson(reviewerConfigParsed);
    const reviewerConfigHash = sha256Hex(reviewerConfigJson);

    try {
      const created = await this.database.$transaction(async tx => {
        const raced = await tx.reviewRequest.findFirst({ where: { executionSessionId, status: { in: [...ACTIVE_REVIEW_STATUSES] } } });
        if (raced) return { duplicateId: raced.id } as const;
        const priorAttempts = await tx.reviewRequest.count({ where: { executionSessionId } });
        // Attempt numbering is only known atomically inside this transaction, and requestHash binds it — so the capsule/hash must be built here, not before.
        const capsule = this.buildReviewInputCapsuleOrThrow(reviewRequestId, requestedAt, session, projectId, reviewerId, approval, authority.mode, diagnosticRequested, artifactEvidence.log);
        const reviewInputHash = computeReviewInputHash(capsule);
        const requestHash = computeRequestHash({
          reviewInputHash, reviewerConfigHash, reviewerId, reviewAuthority: authority.mode,
          requestedBy: actor, attempt: priorAttempts, reviewPolicyVersion: capsule.reviewPolicyVersion
        });
        // The exact material envelope this request authorizes, measured now
        // that its own identity is known. The ledger is bound into the row, so
        // the budget a review was authorized under can never be reinterpreted
        // afterwards -- and finalization rebuilds it from current evidence and
        // requires the same result.
        let materialBudgetLedgerJson = "{}";
        let materialBudgetLedgerHash = "";
        let materialBudgetPolicyVersion = "";
        if (authority.mode === "AUTHORITATIVE") {
          const materialPolicy = checkAuthoritativeMaterialPolicy(capsule, this.policyPromptFor(reviewerId), requestHash);
          if (!materialPolicy.ok) throw new ReviewAuthorityError(materialPolicy.reason);
          materialBudgetLedgerJson = canonicalJson(materialPolicy.ledger);
          materialBudgetLedgerHash = materialPolicy.ledgerHash;
          materialBudgetPolicyVersion = MATERIAL_BUDGET_POLICY_VERSION;
        }
        const row = await tx.reviewRequest.create({ data: {
          id: reviewRequestId, executionSessionId, projectId, taskId: session.taskId, reviewerId,
          reviewAuthority: authority.mode, diagnosticRequested,
          approvalId: approval.id, approvalStatus: approval.status,
          approvalReviewerSelection: capsule.approvedReviewer, taskSelectedReviewer: capsule.taskSelectedReviewer,
          executionExecutorId: session.executorId,
          status: "PENDING", attempt: priorAttempts,
          taskSpecHash: capsule.taskSpecHash, approvalSnapshotHash: capsule.approvalSnapshotHash,
          executionCapsuleHash: capsule.executionCapsuleHash, baselineGitEvidenceHash: capsule.baselineGitEvidenceHash,
          finalGitEvidenceHash: capsule.finalGitEvidenceHash, verificationResultsHash: capsule.verificationResultsHash,
          executionArtifactSetHash: capsule.executionArtifactSetHash, executionResultStatus: capsule.executionResultStatus,
          finalBranch: capsule.finalBranch, finalHead: capsule.finalHead, reviewPolicyVersion: capsule.reviewPolicyVersion,
          reviewInputJson: canonicalJson(capsule), reviewInputHash, requestHash,
          reviewerConfigJson, reviewerConfigHash,
          materialBudgetPolicyVersion, materialBudgetLedgerJson, materialBudgetLedgerHash,
          requestedBy: actor, requestedAt
        } });
        await this.appendEventTx(tx, row.id, "REVIEW_REQUESTED", "INFO", `Review requested from ${reviewer.describe().displayName}.`, { requestHash, reviewInputHash, reviewerId, reviewAuthority: authority.mode });
        await tx.auditEvent.create({ data: {
          id: randomUUID(), projectId, taskId: session.taskId, executionSessionId, actor,
          action: "REVIEW_REQUEST_AUTHORIZED", riskLevel: "REVIEW", detailsJson: this.boundedPayload({ reviewRequestId: row.id, requestHash, reviewAuthority: authority.mode })
        } });
        return { id: row.id } as const;
      });

      if ("duplicateId" in created) {
        const existing = await this.getReviewRequest(created.duplicateId);
        if (!existing) throw new ReviewConflictError("The active review disappeared during an idempotent request.");
        return { reviewRequest: existing, duplicate: true };
      }
      const reviewRequest = await this.getReviewRequest(created.id);
      if (!reviewRequest) throw new ReviewNotFoundError("Created review request was not found.");
      // No fire-and-forget: the row is created PENDING and picked up by a
      // ReviewRuntimeHost's durable claim loop, so a crashed API request or
      // restarted runtime can never strand or silently drop the review.
      return { reviewRequest, duplicate: false };
    } catch (error) {
      // A material-policy failure raised inside the transaction still gets the
      // same audited rejection as one caught before it, so which side of the
      // transaction boundary a check happens to live on never changes whether
      // the refusal is recorded.
      if (error instanceof ReviewAuthorityError) {
        await this.auditRejected(session, projectId, actor, error.message);
        throw error;
      }
      if (!isUniqueFailure(error)) throw error;
      const raced = await this.database.reviewRequest.findFirst({ where: { executionSessionId, status: { in: [...ACTIVE_REVIEW_STATUSES] } } });
      if (!raced) throw error;
      const existing = await this.getReviewRequest(raced.id);
      if (!existing) throw error;
      return { reviewRequest: existing, duplicate: true };
    }
  }

  /** Atomically claims the oldest PENDING review for the given runtime-host owner. Returns null if nothing is claimable or another owner won the race. */
  async claimNext(ownerId: string): Promise<{ reviewRequestId: string; leaseToken: string; claimAttempt: number } | null> {
    const candidate = await this.database.reviewRequest.findFirst({ where: { status: "PENDING" }, orderBy: [{ requestedAt: "asc" }, { createdAt: "asc" }] });
    if (!candidate) return null;
    const now = this.clock.now();
    const leaseToken = randomUUID();
    const claimAttempt = candidate.claimAttempts + 1;
    const claimed = await this.database.reviewRequest.updateMany({
      where: { id: candidate.id, status: "PENDING" },
      data: { status: "CLAIMED", ownerId, leaseToken, claimedAt: now, heartbeatAt: now, leaseExpiresAt: new Date(now.getTime() + this.leaseMs), claimAttempts: claimAttempt }
    });
    if (claimed.count !== 1) return null;
    await this.appendEvent(candidate.id, "REVIEW_CLAIMED", "INFO", "Review claimed by a runtime host.", { ownerId });
    return { reviewRequestId: candidate.id, leaseToken, claimAttempt };
  }

  async heartbeat(reviewRequestId: string, leaseToken: string): Promise<boolean> {
    const now = this.clock.now();
    const updated = await this.database.reviewRequest.updateMany({
      where: { id: reviewRequestId, leaseToken, status: { in: ["CLAIMED", "RUNNING", "CANCELLATION_REQUESTED"] } },
      data: { heartbeatAt: now, leaseExpiresAt: new Date(now.getTime() + this.leaseMs) }
    });
    return updated.count > 0;
  }

  /** Ownership-scoped CAS predicate shared by every terminal write: only the runtime host holding this exact, still-live claim generation may transition the row. */
  private ownershipWhere(reviewRequestId: string, ownership: ClaimOwnership, status: ReviewRequestStatus, now: Date) {
    return { id: reviewRequestId, status, ownerId: ownership.ownerId, leaseToken: ownership.leaseToken, claimAttempts: ownership.claimAttempt, leaseExpiresAt: { gt: now } };
  }

  /**
   * Called after a finalization CAS matched zero rows. If a cancellation
   * request is still waiting AND this caller still holds the exact ownership
   * generation it started with (and that lease has not itself expired), it
   * safely resolves the cancellation. In every other case — ownership lost,
   * changed, or expired, row already terminal, nothing pending — this is a
   * no-op: an expired or superseded owner is never revived, and never
   * produces a write. recoverStaleReviews is the only other path allowed to
   * resolve an ownerless row.
   */
  private async resolveFinalizationRace(reviewRequestId: string, ownership: ClaimOwnership): Promise<void> {
    await this.database.$transaction(async tx => {
      const now = this.clock.now();
      const current = await tx.reviewRequest.findUniqueOrThrow({ where: { id: reviewRequestId } });
      const status = reviewRequestStatusSchema.parse(current.status);
      if (isTerminalReviewStatus(status)) return;
      if (current.ownerId !== ownership.ownerId || current.leaseToken !== ownership.leaseToken || current.claimAttempts !== ownership.claimAttempt) return;
      if (status !== "CANCELLATION_REQUESTED") return;
      if (!current.leaseExpiresAt || current.leaseExpiresAt <= now) return;
      assertReviewTransition("CANCELLATION_REQUESTED", "CANCELLED");
      await tx.reviewRequest.update({ where: { id: reviewRequestId }, data: { status: "CANCELLED", finishedAt: now, ...RELEASED_LEASE_FIELDS } });
      await this.appendEventTx(tx, reviewRequestId, "REVIEW_CANCELLED", "INFO", "Review cancelled.");
      await tx.auditEvent.create({ data: {
        id: randomUUID(), projectId: current.projectId, taskId: current.taskId, executionSessionId: current.executionSessionId, actor: "review-engine",
        action: "REVIEW_CANCELLATION_AUTHORIZED", riskLevel: "REVIEW", detailsJson: this.boundedPayload({ reviewRequestId })
      } });
    });
  }

  /**
   * Terminal ERROR or STALE write (reviewer missing, reviewer threw, output
   * failed validation/hash-echo, or corrupted immutable input detected before
   * or after the reviewer ran). Ownership-scoped like every other terminal
   * write. A STALE write also appends the same audit event the evidence-drift
   * STALE path does, so every non-verdict terminal outcome is equally
   * auditable regardless of which check caught it.
   */
  private async finalizeNonVerdict(reviewRequestId: string, ownership: ClaimOwnership, fromStatus: "CLAIMED" | "RUNNING", status: "ERROR" | "STALE", message: string, failureCode: string, failureMessage: string | null): Promise<void> {
    const applied = await this.database.$transaction(async tx => {
      const now = this.clock.now();
      const row = await tx.reviewRequest.findUniqueOrThrow({ where: { id: reviewRequestId } });
      const updated = await tx.reviewRequest.updateMany({
        where: this.ownershipWhere(reviewRequestId, ownership, fromStatus, now),
        data: {
          status, finishedAt: now, ...(status === "STALE" ? { invalidatedAt: now } : {}),
          failureCode, ...(failureMessage ? { failureMessage: redactSecrets(failureMessage).slice(0, 2_000) } : {}), ...RELEASED_LEASE_FIELDS
        }
      });
      if (!updated.count) return false;
      await this.appendEventTx(tx, reviewRequestId, status === "ERROR" ? "REVIEW_ERROR" : "REVIEW_STALE_INVALIDATED", status === "ERROR" ? "ERROR" : "WARNING", message);
      if (status === "STALE") {
        await tx.auditEvent.create({ data: {
          id: randomUUID(), projectId: row.projectId, taskId: row.taskId, executionSessionId: row.executionSessionId, actor: "review-engine",
          action: "REVIEW_STALE_INVALIDATED", riskLevel: "REVIEW", detailsJson: this.boundedPayload({ reviewRequestId, reason: message })
        } });
      }
      return true;
    });
    if (!applied) await this.resolveFinalizationRace(reviewRequestId, ownership);
  }

  /**
   * Re-derives the persisted, hash-bound reviewer input from scratch: parses
   * and validates reviewInputJson/reviewerConfigJson against their runtime
   * schemas, recomputes reviewInputHash/reviewerConfigHash from the validated
   * (canonicalized) values, requires both to equal the persisted hashes, then
   * reconstructs requestHash from them and requires that to match too. Never
   * trusts a persisted hash merely because the database trigger normally
   * protects it — this is the runtime's own independent check, run both
   * before the reviewer is ever invoked and again at final revalidation.
   */
  private verifyImmutableInputBinding(row: ReviewRequestRow): { ok: true; capsule: ReviewInputCapsule; reviewerConfig: unknown } | { ok: false; reason: string } {
    const capsuleCheck = verifyJsonHashBinding(reviewInputCapsuleSchema, row.reviewInputJson, row.reviewInputHash);
    if (!capsuleCheck.ok) return { ok: false, reason: "reviewInputJson failed schema validation or no longer matches its recorded reviewInputHash." };

    const configSchema = reviewerConfigSchemaFor(row.reviewerId);
    const configCheck = verifyJsonHashBinding(configSchema, row.reviewerConfigJson, row.reviewerConfigHash);
    if (!configCheck.ok) return { ok: false, reason: "reviewerConfigJson failed schema validation or no longer matches its recorded reviewerConfigHash." };

    const recomputedRequestHash = computeRequestHash({
      reviewInputHash: row.reviewInputHash, reviewerConfigHash: row.reviewerConfigHash,
      reviewerId: row.reviewerId, reviewAuthority: reviewAuthoritySchema.parse(row.reviewAuthority),
      requestedBy: row.requestedBy, attempt: row.attempt, reviewPolicyVersion: row.reviewPolicyVersion
    });
    if (recomputedRequestHash !== row.requestHash) {
      return { ok: false, reason: "requestHash no longer matches a fresh recomputation from reviewInputHash and reviewerConfigHash." };
    }
    return { ok: true, capsule: capsuleCheck.value, reviewerConfig: configCheck.value };
  }

  /**
   * Rebuilds the COMPLETE authoritative binding from current source-of-truth
   * rows and current artifact bytes: the capsule, its input hash, this
   * request's identity, the material envelope, its exact ledger, and the
   * reviewer's exact prompt and stdin.
   *
   * Used in both places that must agree: before the process is created (where
   * the result is what gets persisted and sent) and again at finalization
   * (where the result is compared against what was persisted). One
   * implementation, so "the reconstruction matches" cannot degrade into "two
   * separately written code paths happen to agree today".
   */
  private async reconstructAuthoritativeBinding(
    row: ReviewRequestRow, reviewer: RelayReviewer, tx?: Prisma.TransactionClient
  ): Promise<
    | { ok: true; prepared: PreparedReviewInvocation; capsule: ReviewInputCapsule }
    | { ok: false; reason: string; code: AuthoritativeFailureCode }
  > {
    const client = tx ?? this.database;
    const session = await client.executionSession.findUnique({ where: { id: row.executionSessionId }, include: sessionInclude });
    if (!session || session.projectId !== row.projectId) {
      return { ok: false, code: "EVIDENCE_CHANGED", reason: "The execution session or its project ownership changed after the review was requested." };
    }
    const approval = session.task.approvals.find(item => item.id === row.approvalId);
    if (!approval) return { ok: false, code: "EVIDENCE_CHANGED", reason: "The task approval used for this execution no longer exists." };

    // Current artifact bytes, re-read and re-validated, with artifact/database
    // semantic equality re-proved -- never the bytes validated at request time.
    const artifactEvidence = await this.validateAuthoritativeArtifactEvidence(session, "AUTHORITATIVE");
    if (!artifactEvidence.ok) return { ok: false, code: artifactEvidence.code, reason: artifactEvidence.reason };

    const capsuleResult = this.buildReviewInputCapsule(
      row.id, row.requestedAt, session, row.projectId, row.reviewerId, approval,
      reviewAuthoritySchema.parse(row.reviewAuthority), row.diagnosticRequested, artifactEvidence.log
    );
    if (!capsuleResult.ok) return { ok: false, code: "EVIDENCE_CHANGED", reason: capsuleResult.reason };

    // The identity of the evidence as it stands NOW must reproduce the
    // identity this request was created with. Evidence that changed
    // coherently -- artifact bytes and database projection both rewritten to a
    // valid new state -- differs here even though every internal consistency
    // check still passes.
    const reviewInputHash = computeReviewInputHash(capsuleResult.capsule);
    const requestHash = computeRequestHash({
      reviewInputHash, reviewerConfigHash: row.reviewerConfigHash, reviewerId: row.reviewerId,
      reviewAuthority: reviewAuthoritySchema.parse(row.reviewAuthority), requestedBy: row.requestedBy,
      attempt: row.attempt, reviewPolicyVersion: row.reviewPolicyVersion
    });
    if (requestHash !== row.requestHash) {
      return { ok: false, code: "EVIDENCE_CHANGED", reason: "The review requestHash no longer matches a freshly reconstructed input capsule; the evidence changed after this review was requested." };
    }
    if (row.materialBudgetPolicyVersion !== MATERIAL_BUDGET_POLICY_VERSION) {
      return { ok: false, code: "EVIDENCE_CHANGED", reason: `This review was authorized under material budget policy '${row.materialBudgetPolicyVersion}', but this build enforces '${MATERIAL_BUDGET_POLICY_VERSION}'; it cannot proceed under a different policy.` };
    }

    const configCheck = verifyJsonHashBinding(reviewerConfigSchemaFor(row.reviewerId), row.reviewerConfigJson, row.reviewerConfigHash);
    if (!configCheck.ok) return { ok: false, code: "REVIEW_IMMUTABLE_INPUT_MISMATCH", reason: "reviewerConfigJson failed schema validation or no longer matches its recorded reviewerConfigHash." };

    const preparation = prepareReviewInvocation({
      capsule: capsuleResult.capsule, requestHash, reviewInputHash,
      reviewerConfigHash: row.reviewerConfigHash, reviewer, reviewerConfig: configCheck.value
    });
    if (!preparation.ok) return { ok: false, code: "EVIDENCE_CHANGED", reason: preparation.reason };
    if (row.materialBudgetLedgerHash && row.materialBudgetLedgerHash !== preparation.prepared.ledgerHash) {
      return { ok: false, code: "EVIDENCE_CHANGED", reason: "The reconstructed material byte ledger no longer matches the ledger this review request was bound to." };
    }
    return { ok: true, prepared: preparation.prepared, capsule: capsuleResult.capsule };
  }

  /**
   * Immediately before accepting any verdict: first re-verifies the immutable
   * input binding itself (reviewInputJson/reviewerConfigJson/requestHash,
   * exactly as verifyImmutableInputBinding does before the reviewer runs —
   * corruption here is reported as REVIEW_IMMUTABLE_INPUT_MISMATCH), then
   * re-reads every live source-of-truth row fresh from within the caller's
   * transaction (never trusts the ReviewRequest row's own snapshot columns)
   * and re-runs eligibility, spec-integrity, and reviewer-authority
   * resolution, then reconstructs the full ReviewInputCapsule and requires it
   * to reproduce the original requestHash bit-for-bit (reported as
   * EVIDENCE_CHANGED). Any drift — corrupted input binding, evidence, task
   * title/objective/context, approval, task status, reviewer authority, or
   * capsule integrity — is reported as a STALE reason/code instead of a
   * boolean, so the event/audit trail records exactly what changed.
   */
  private async revalidateForVerdict(
    tx: Prisma.TransactionClient, row: ReviewRequestRow, verdict: StructuredReviewVerdict
  ): Promise<{ ok: true } | { ok: false; reason: string; code: AuthoritativeFailureCode }> {
    const bindingCheck = this.verifyImmutableInputBinding(row);
    if (!bindingCheck.ok) return { ok: false, reason: bindingCheck.reason, code: "REVIEW_IMMUTABLE_INPUT_MISMATCH" };

    const session = await tx.executionSession.findUnique({ where: { id: row.executionSessionId }, include: sessionInclude });
    if (!session || session.projectId !== row.projectId) return { ok: false, code: "EVIDENCE_CHANGED", reason: "The execution session or its project ownership changed after the review was requested." };
    if (session.task.specHash !== session.approvedSpecHash) return { ok: false, code: "EVIDENCE_CHANGED", reason: "The task specification changed after this execution completed." };

    const eligibilityFailure = await this.checkEligibility(session);
    if (eligibilityFailure) return { ok: false, code: "EVIDENCE_CHANGED", reason: eligibilityFailure.reason };

    const approval = session.task.approvals.find(item => item.id === row.approvalId);
    if (!approval) return { ok: false, code: "EVIDENCE_CHANGED", reason: "The task approval used for this execution no longer exists." };
    if (sha256Hex(approval.approvedSpecJson) !== row.approvalSnapshotHash) return { ok: false, code: "EVIDENCE_CHANGED", reason: "The task approval snapshot changed after the review was requested." };

    const specIntegrity = this.specIntegrityFailure(session, approval);
    if (specIntegrity) return { ok: false, code: "EVIDENCE_CHANGED", reason: specIntegrity.reason };

    const authority = resolveReviewerAuthority({
      requestedReviewerId: row.reviewerId,
      approvalStatus: approval.status,
      approvalReviewerSelection: reviewerSelectionSchema.parse(approval.reviewer),
      taskSelectedReviewer: reviewerSelectionSchema.parse(session.task.reviewer),
      executionExecutorId: session.executorId,
      diagnosticRequested: row.diagnosticRequested,
      allowFakeExecutorDiagnosticReviews: this.allowFakeExecutorDiagnosticReviews,
      allowCodexTestDoubleDiagnosticReviews: this.allowCodexTestDoubleDiagnosticReviews
    });
    if (!authority.authorized) return { ok: false, code: "EVIDENCE_CHANGED", reason: authority.reason };
    if (authority.mode !== row.reviewAuthority) return { ok: false, code: "EVIDENCE_CHANGED", reason: "The review authority mode changed after the review was requested." };

    // AUTHORITATIVE-only artifact-store gate, re-checked live: reported under
    // its own specific code (ARTIFACT_STORE_UNAVAILABLE, ARTIFACT_STORE_READ_FAILURE,
    // or LOG_PROVENANCE_ARTIFACT_MISMATCH), all of which finalizeAcceptedVerdict
    // maps to ERROR, never STALE, rather than folded into ordinary evidence drift.
    const artifactEvidence = await this.validateAuthoritativeArtifactEvidence(session, authority.mode);
    if (!artifactEvidence.ok) return { ok: false, code: artifactEvidence.code, reason: artifactEvidence.reason };

    const capsuleResult = this.buildReviewInputCapsule(row.id, row.requestedAt, session, row.projectId, row.reviewerId, approval, authority.mode, row.diagnosticRequested, artifactEvidence.log);
    if (!capsuleResult.ok) return { ok: false, code: "EVIDENCE_CHANGED", reason: capsuleResult.reason };
    const currentCapsule = capsuleResult.capsule;
    const currentRequestHash = computeRequestHash({
      reviewInputHash: computeReviewInputHash(currentCapsule), reviewerConfigHash: row.reviewerConfigHash,
      reviewerId: row.reviewerId, reviewAuthority: authority.mode, requestedBy: row.requestedBy, attempt: row.attempt, reviewPolicyVersion: row.reviewPolicyVersion
    });
    if (currentRequestHash !== row.requestHash) {
      return { ok: false, code: "EVIDENCE_CHANGED", reason: "The review requestHash no longer matches a freshly reconstructed input capsule." };
    }
    if (authority.mode === "AUTHORITATIVE") {
      // ENGINE-OWNED finalization reconstruction. Nothing here relies on a
      // check the reviewer already performed: the reviewer is the party whose
      // output is being judged, so its own account of what it was sent has no
      // authority. Everything is rebuilt independently -- the capsule, the
      // material envelope, the exact ledger, the exact prompt and stdin -- and
      // each identity must equal the one the PREPARING row committed to before
      // the process started.
      const reviewer = this.reviewers.get(row.reviewerId);
      if (!reviewer) return { ok: false, code: "INVOCATION_BINDING_MISMATCH", reason: "The reviewer that produced this result is no longer registered, so its transmitted material cannot be independently reconstructed." };
      const reconstruction = await this.reconstructAuthoritativeBinding(row, reviewer, tx);
      if (!reconstruction.ok) return { ok: false, code: reconstruction.code, reason: reconstruction.reason };

      const invocation = await tx.reviewInvocation.findUnique({ where: { reviewRequestId: row.id } });
      if (!invocation) return { ok: false, code: "INVOCATION_BINDING_MISMATCH", reason: "No reviewer invocation exists for this review, so its verdict cannot be tied to any transmitted material." };
      const identity = compareInvocationIdentity(preparedInvocationIdentity(reconstruction.prepared), invocation);
      if (!identity.ok) return { ok: false, code: "INVOCATION_BINDING_MISMATCH", reason: identity.reason };

      // What the reviewer echoed must match the independent reconstruction,
      // not merely whatever it was handed: a reviewer that echoes its own
      // input back proves only that it can copy.
      if (verdict.reviewedMaterialHash !== undefined && verdict.reviewedMaterialHash !== reconstruction.prepared.materialHash) {
        return { ok: false, code: "REVIEWER_ECHO_MISMATCH", reason: "The reviewer echoed a review-material hash that does not match the independently reconstructed material." };
      }
      if (verdict.reviewedPromptHash !== undefined && verdict.reviewedPromptHash !== reconstruction.prepared.promptHash) {
        return { ok: false, code: "REVIEWER_ECHO_MISMATCH", reason: "The reviewer echoed a prompt hash that does not match the independently reconstructed prompt." };
      }
    }
    return { ok: true };
  }

  /**
   * Accepts or invalidates a reviewer's structured verdict. Revalidation, the
   * terminal status CAS (scoped to the exact claim generation that is still
   * live), and the append-only ReviewVerdict insert all happen inside one
   * transaction — so a lease that expires or is reclaimed between the
   * reviewer's output and this call can never result in a persisted verdict.
   */
  private async finalizeAcceptedVerdict(reviewRequestId: string, ownership: ClaimOwnership, verdict: StructuredReviewVerdict): Promise<void> {
    const outcome = await this.database.$transaction(async tx => {
      const now = this.clock.now();
      const row = await tx.reviewRequest.findUniqueOrThrow({ where: { id: reviewRequestId } });
      if (row.status !== "RUNNING" || row.ownerId !== ownership.ownerId || row.leaseToken !== ownership.leaseToken || row.claimAttempts !== ownership.claimAttempt || !row.leaseExpiresAt || row.leaseExpiresAt <= now) {
        return "ownership-lost" as const;
      }

      const revalidation = await this.revalidateForVerdict(tx, row, verdict);
      await this.appendEventTx(tx, reviewRequestId, "REVIEW_EVIDENCE_RECHECKED", "INFO", "Revalidated authority and evidence bindings before accepting the verdict.");

      if (!revalidation.ok) {
        // Only genuine evidence drift is STALE. An artifact-store
        // availability/read failure, a corrupted immutable binding, an
        // invocation whose committed identity does not match the independent
        // reconstruction, and a reviewer echoing the wrong hashes are all
        // ERROR (no invalidatedAt, matching every other ERROR path here):
        // they describe an impossible or malformed authority state, not a
        // world that legitimately moved on. No path here reruns the reviewer.
        const isEvidenceDrift = STALE_FAILURE_CODES.has(revalidation.code);
        const isArtifactStoreFailure = !isEvidenceDrift;
        const targetStatus = isEvidenceDrift ? "STALE" : "ERROR";
        const updated = await tx.reviewRequest.updateMany({
          where: this.ownershipWhere(reviewRequestId, ownership, "RUNNING", now),
          data: {
            status: targetStatus, finishedAt: now, ...(isEvidenceDrift ? { invalidatedAt: now } : {}),
            failureCode: revalidation.code, failureMessage: redactSecrets(revalidation.reason).slice(0, 2_000), ...RELEASED_LEASE_FIELDS
          }
        });
        if (!updated.count) return "ownership-lost" as const;
        await this.appendEventTx(tx, reviewRequestId, isArtifactStoreFailure ? "REVIEW_ERROR" : "REVIEW_STALE_INVALIDATED", isArtifactStoreFailure ? "ERROR" : "WARNING", revalidation.reason);
        if (!isArtifactStoreFailure) {
          await tx.auditEvent.create({ data: {
            id: randomUUID(), projectId: row.projectId, taskId: row.taskId, executionSessionId: row.executionSessionId, actor: "review-engine",
            action: "REVIEW_STALE_INVALIDATED", riskLevel: "REVIEW", detailsJson: this.boundedPayload({ reviewRequestId, reason: revalidation.reason })
          } });
        }
        return isArtifactStoreFailure ? "error" as const : "stale" as const;
      }

      const updated = await tx.reviewRequest.updateMany({
        where: this.ownershipWhere(reviewRequestId, ownership, "RUNNING", now),
        data: { status: terminalByVerdict[verdict.verdict], finishedAt: now, ...RELEASED_LEASE_FIELDS }
      });
      if (!updated.count) return "ownership-lost" as const;
      // Application-level CAS above already guarantees at most one winner; the
      // database-level UNIQUE constraint on ReviewVerdict.reviewRequestId (see
      // migration) is a second, independent backstop against a duplicate verdict.
      await tx.reviewVerdict.create({ data: {
        id: randomUUID(), reviewRequestId, verdict: verdict.verdict, summary: redactSecrets(verdict.summary),
        findingsJson: canonicalJson(verdict.findings), requiredActionsJson: canonicalJson(verdict.requiredActions),
        confidence: verdict.confidence, reviewerVersion: verdict.reviewerVersion, reviewedRequestHash: verdict.reviewedRequestHash
      } });
      await this.appendEventTx(tx, reviewRequestId, eventByVerdict[verdict.verdict], "INFO", verdict.summary, {
        verdict: verdict.verdict, findingCount: verdict.findings.length, reviewAuthority: row.reviewAuthority
      });
      await tx.auditEvent.create({ data: {
        id: randomUUID(), projectId: row.projectId, taskId: row.taskId, executionSessionId: row.executionSessionId, actor: "review-engine",
        action: "REVIEW_VERDICT_RECORDED", riskLevel: "REVIEW", detailsJson: this.boundedPayload({ reviewRequestId, verdict: verdict.verdict, reviewAuthority: row.reviewAuthority })
      } });
      return "applied" as const;
    });
    if (outcome === "ownership-lost") await this.resolveFinalizationRace(reviewRequestId, ownership);
  }

  /** Runs a review this engine (or another instance sharing the same database) has already claimed. */
  async runClaimed(reviewRequestId: string, leaseToken: string): Promise<void> {
    const claimedRow = await this.database.reviewRequest.findFirst({ where: { id: reviewRequestId, leaseToken, status: "CLAIMED" } });
    if (!claimedRow?.ownerId) throw new ReviewConflictError("The review lease is missing or owned by another runtime.");
    const ownership: ClaimOwnership = { ownerId: claimedRow.ownerId, leaseToken, claimAttempt: claimedRow.claimAttempts };
    const reviewer = this.reviewers.get(claimedRow.reviewerId);
    const controller = new AbortController();
    this.controllers.set(reviewRequestId, controller);
    // Heartbeat loss must actually stop the owned process, not merely go
    // unnoticed: when a heartbeat fails (lease expired or reclaimed by
    // another owner), this aborts the same AbortSignal the reviewer's own
    // process-running boundary observes, which terminates the owned
    // process and only then lets reviewer.review() return/throw --
    // "waiting for actual process exit" falls out of that existing
    // async-generator plumbing, not a separate wait here.
    let ownershipLost = false;
    // Single guarded entry point for every way heartbeat can signal ownership
    // loss (a clean `false` return, or the heartbeat call itself throwing --
    // e.g. a transient database error). Idempotent: only the first call
    // aborts the controller, so a throwing heartbeat that keeps firing on
    // every subsequent tick can never re-abort or double-count. Aborting the
    // same AbortSignal the reviewer's process-running boundary observes is
    // what actually terminates the owned process; reviewer.review() then
    // returns/throws once that process exits, which the `finally` below
    // already waits on before finalizing the invocation.
    const handleHeartbeatOwnershipLoss = (reason: string): void => {
      if (ownershipLost) return;
      ownershipLost = true;
      controller.abort(new Error(reason));
    };
    const heartbeatTimer = setInterval(() => {
      void (async () => {
        try {
          const ok = await this.heartbeat(reviewRequestId, leaseToken);
          if (!ok) handleHeartbeatOwnershipLoss("Review lease ownership was lost (heartbeat failed); aborting the active reviewer process.");
        } catch (error) {
          // A thrown heartbeat is exactly as much an ownership-loss signal as
          // a clean `false`: the lease's true state is now unknown, so the
          // owned process must still be aborted rather than left running
          // unsupervised. Never rethrown -- this runs inside a detached timer
          // callback, so an unhandled rejection here would crash the runtime.
          handleHeartbeatOwnershipLoss(`Review lease heartbeat failed with an error (treated as ownership loss): ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
        }
      })();
    }, Math.max(25, Math.floor(this.leaseMs / 3)));
    let invocationId: string | undefined;
    let invocationOutcome: Exclude<InvocationStatus, "PREPARING" | "RUNNING"> = "FAILED";
    try {
      if (!reviewer) {
        await this.finalizeNonVerdict(reviewRequestId, ownership, "CLAIMED", "ERROR", "The registered reviewer disappeared before the review could run.", "REVIEWER_MISSING", null);
        return;
      }

      const transitioned = await this.database.$transaction(async tx => {
        const now = this.clock.now();
        const current = await tx.reviewRequest.findUniqueOrThrow({ where: { id: reviewRequestId } });
        if (current.status !== "CLAIMED" || current.ownerId !== ownership.ownerId || current.leaseToken !== ownership.leaseToken || current.claimAttempts !== ownership.claimAttempt) return false;
        if (!current.leaseExpiresAt || current.leaseExpiresAt <= now) return false;
        assertReviewTransition("CLAIMED", "RUNNING");
        await tx.reviewRequest.update({ where: { id: reviewRequestId }, data: { status: "RUNNING", startedAt: now } });
        await this.appendEventTx(tx, reviewRequestId, "REVIEW_STARTED", "INFO", `${reviewer.describe().displayName} started the review.`);
        return true;
      });
      if (!transitioned) return;

      const row = await this.database.reviewRequest.findUniqueOrThrow({ where: { id: reviewRequestId } });

      // Never trust the persisted reviewInputJson/reviewerConfigJson merely
      // because the database trigger normally protects them: independently
      // re-parse, re-validate, and re-hash before the reviewer is ever
      // invoked. A corrupt, imported, or legacy row is caught here, never
      // silently repaired, and never handed to the reviewer.
      const bindingCheck = this.verifyImmutableInputBinding(row);
      if (!bindingCheck.ok) {
        await this.finalizeNonVerdict(reviewRequestId, ownership, "RUNNING", "STALE", bindingCheck.reason, "REVIEW_IMMUTABLE_INPUT_MISMATCH", bindingCheck.reason);
        return;
      }

      // AUTHORITATIVE-only artifact-store gate, live, immediately before the
      // reviewer is invoked (Milestone 2.3B fourth corrective pass): this is
      // what makes "block before Claude process spawn" true even for a store
      // that becomes unreadable between claim and run, not merely one that
      // was never configured (already caught at request time). A failure
      // here is persisted as ERROR, and neither the ReviewInvocation row nor
      // reviewer.review() is ever created/called.
      // The COMPLETE pre-spawn reconstruction (Milestone 2.3B seventh
      // corrective pass). It is not enough to re-validate the current
      // artifacts and then invoke the reviewer with the older persisted
      // capsule: evidence that changed COHERENTLY after the request was
      // created (artifact bytes and database projection both rewritten to a
      // valid new state, each with correctly recomputed self-hashes) passes
      // every internal-consistency check while describing a different run.
      // The only thing that catches it is rebuilding the whole binding from
      // current source-of-truth rows and requiring it to reproduce this
      // request's identity exactly. A mismatch is STALE with no invocation
      // row, no reviewer call, and no process -- Claude is never knowingly
      // run against evidence whose verdict would have to be rejected later.
      let prepared: PreparedReviewInvocation | null = null;
      if (row.reviewAuthority === "AUTHORITATIVE") {
        const reconstruction = await this.reconstructAuthoritativeBinding(row, reviewer);
        if (!reconstruction.ok) {
          const status = reconstruction.code === "EVIDENCE_CHANGED" ? "STALE" : "ERROR";
          await this.finalizeNonVerdict(reviewRequestId, ownership, "RUNNING", status, reconstruction.reason, reconstruction.code, reconstruction.reason);
          return;
        }
        prepared = reconstruction.prepared;
      }

      // The reviewer receives exactly the validated, persisted, hash-bound
      // capsule and its validated, persisted, hash-bound configuration —
      // never task/execution fields re-assembled from live rows at run time,
      // and never a reviewer configuration appended unbound.
      const capsule: ImmutableReviewCapsule = {
        ...bindingCheck.capsule,
        requestHash: row.requestHash,
        reviewInputHash: row.reviewInputHash,
        reviewerConfigHash: row.reviewerConfigHash,
        ...(reviewer.id === "fake-reviewer" ? { scenario: fakeReviewerScenarioSchema.parse(bindingCheck.reviewerConfig) } : {}),
        ...(reviewer.id === "claude-cli" ? { claudeReviewerConfig: claudeReviewerConfigSchema.parse(bindingCheck.reviewerConfig) } : {})
      };

      // Atomically creates the single ReviewInvocation row for this request
      // (one transaction, re-proving the full ownership predicate together
      // with the insert), before the reviewer is ever invoked. If ownership
      // was already lost between the RUNNING transition above and here, or
      // (should never happen given at-most-one-claim-ever) an invocation
      // already exists, no row is created and reviewer.review() must never
      // be called -- this is the atomic replacement for the old two-step
      // check-then-create, which had a real (if narrow) TOCTOU gap.
      try {
        invocationId = await this.createOwnedInvocationOrThrow(
          reviewRequestId, reviewer.id, ownership, prepared,
          capsule.claudeReviewerConfig?.capabilitySnapshotId ?? null,
          capsule.claudeReviewerConfig ? { contractId: capsule.claudeReviewerConfig.wrapperContractId, parserVersion: capsule.claudeReviewerConfig.wrapperParserVersion } : null
        );
      } catch (error) {
        if (error instanceof InvocationOwnershipLostError) {
          await this.resolveFinalizationRace(reviewRequestId, ownership);
          return;
        }
        await this.finalizeNonVerdict(reviewRequestId, ownership, "RUNNING", "ERROR", "A ReviewInvocation could not be durably created for this review request.", "INVOCATION_CREATION_FAILED", error instanceof Error ? error.message : String(error));
        return;
      }

      let rawVerdict: StructuredReviewVerdict;
      try {
        rawVerdict = await reviewer.review(capsule, {
          signal: controller.signal,
          now: () => this.clock.now(),
          sleep: milliseconds => this.clock.sleep(milliseconds, controller.signal),
          // The exact bytes already committed to the PREPARING row. The
          // reviewer sends these verbatim; it never rebuilds them.
          ...(prepared ? { prepared } : {}),
          recordInvocation: record => this.persistReviewerInvocation(reviewRequestId, ownership, record),
          markInvocationRunning: async processInfo => {
            if (!invocationId) return { ok: false };
            const ok = await this.markInvocationRunning(reviewRequestId, invocationId, ownership, processInfo);
            if (!ok) handleHeartbeatOwnershipLoss("Review invocation could not be durably transitioned to RUNNING (ownership or lease no longer valid); aborting the active reviewer process.");
            return { ok };
          }
        });
      } catch (error) {
        if (ownershipLost) {
          invocationOutcome = "OWNERSHIP_LOST";
          await this.resolveFinalizationRace(reviewRequestId, ownership);
          return;
        }
        const current = await this.database.reviewRequest.findUnique({ where: { id: reviewRequestId }, select: { status: true } });
        if (controller.signal.aborted || current?.status === "CANCELLATION_REQUESTED" || current?.status === "CANCELLED") {
          invocationOutcome = "CANCELLED";
          await this.resolveFinalizationRace(reviewRequestId, ownership);
          return;
        }
        invocationOutcome = "FAILED";
        await this.finalizeNonVerdict(reviewRequestId, ownership, "RUNNING", "ERROR", "The reviewer failed to produce a result.", "ERROR", error instanceof Error ? error.message : String(error));
        return;
      }
      await this.appendEvent(reviewRequestId, "REVIEWER_OUTPUT_RECEIVED", "INFO", "The reviewer produced a structured result.");

      const parsedVerdict = structuredReviewVerdictSchema.safeParse(rawVerdict);
      if (!parsedVerdict.success) {
        invocationOutcome = "FAILED";
        await this.finalizeNonVerdict(reviewRequestId, ownership, "RUNNING", "ERROR", "Reviewer output failed structured validation.", "ERROR", parsedVerdict.error.issues.map(issue => issue.message).join("; "));
        return;
      }
      if (parsedVerdict.data.reviewedRequestHash !== row.requestHash) {
        invocationOutcome = "FAILED";
        await this.finalizeNonVerdict(reviewRequestId, ownership, "RUNNING", "ERROR", "Reviewer output does not reference the requested review's hash.", "ERROR", "reviewedRequestHash mismatch");
        return;
      }

      invocationOutcome = "SUCCEEDED";
      await this.finalizeAcceptedVerdict(reviewRequestId, ownership, parsedVerdict.data);
    } finally {
      clearInterval(heartbeatTimer);
      this.controllers.delete(reviewRequestId);
      if (invocationId) await this.finalizeInvocationStatus(reviewRequestId, ownership, invocationOutcome);
    }
  }

  async cancelReview(reviewRequestId: string, actor = "local-user") {
    type CancelOutcome =
      | { kind: "notFound" }
      | { kind: "terminal" }
      | { kind: "cancelled" }
      | { kind: "requested"; reviewerId: string };
    const outcome: CancelOutcome = await this.database.$transaction(async (tx): Promise<CancelOutcome> => {
      const row = await tx.reviewRequest.findUnique({ where: { id: reviewRequestId } });
      if (!row) return { kind: "notFound" };
      const status = reviewRequestStatusSchema.parse(row.status);
      if (isTerminalReviewStatus(status)) return { kind: "terminal" };
      if (status === "CANCELLATION_REQUESTED") return { kind: "requested", reviewerId: row.reviewerId };
      if (status === "PENDING") {
        const updated = await tx.reviewRequest.updateMany({ where: { id: reviewRequestId, status: "PENDING" }, data: { status: "CANCELLED", finishedAt: this.clock.now(), cancellationRequestedAt: this.clock.now() } });
        if (!updated.count) {
          const fresh = await tx.reviewRequest.findUniqueOrThrow({ where: { id: reviewRequestId } });
          return isTerminalReviewStatus(reviewRequestStatusSchema.parse(fresh.status)) ? { kind: "terminal" } : { kind: "requested", reviewerId: fresh.reviewerId };
        }
        await this.appendEventTx(tx, reviewRequestId, "REVIEW_CANCELLED", "INFO", "Review cancelled before it started.");
        await tx.auditEvent.create({ data: {
          id: randomUUID(), projectId: row.projectId, taskId: row.taskId, executionSessionId: row.executionSessionId, actor,
          action: "REVIEW_CANCELLATION_AUTHORIZED", riskLevel: "REVIEW", detailsJson: this.boundedPayload({ reviewRequestId })
        } });
        return { kind: "cancelled" };
      }
      // CLAIMED or RUNNING: CAS into CANCELLATION_REQUESTED so this can race a verdict transaction safely.
      const updated = await tx.reviewRequest.updateMany({ where: { id: reviewRequestId, status: { in: ["CLAIMED", "RUNNING"] } }, data: { status: "CANCELLATION_REQUESTED", cancellationRequestedAt: this.clock.now() } });
      if (!updated.count) {
        const fresh = await tx.reviewRequest.findUniqueOrThrow({ where: { id: reviewRequestId } });
        return isTerminalReviewStatus(reviewRequestStatusSchema.parse(fresh.status)) ? { kind: "terminal" } : { kind: "requested", reviewerId: fresh.reviewerId };
      }
      await this.appendEventTx(tx, reviewRequestId, "REVIEW_CANCELLATION_REQUESTED", "INFO", "Cancellation requested by the local user.");
      await tx.auditEvent.create({ data: {
        id: randomUUID(), projectId: row.projectId, taskId: row.taskId, executionSessionId: row.executionSessionId, actor,
        action: "REVIEW_CANCELLATION_AUTHORIZED", riskLevel: "REVIEW", detailsJson: this.boundedPayload({ reviewRequestId })
      } });
      return { kind: "requested", reviewerId: row.reviewerId };
    });
    if (outcome.kind === "notFound") throw new ReviewNotFoundError("Review request not found.");
    if (outcome.kind === "terminal") return { alreadyTerminal: true, reviewRequest: await this.getReviewRequest(reviewRequestId) };
    if (outcome.kind === "requested") {
      const reviewer = this.reviewers.get(outcome.reviewerId);
      await reviewer?.cancel?.(reviewRequestId);
      this.controllers.get(reviewRequestId)?.abort(new DOMException("Review cancelled.", "AbortError"));
    }
    return { alreadyTerminal: false, reviewRequest: await this.getReviewRequest(reviewRequestId) };
  }

  /**
   * Recovers reviews whose runtime-host lease expired without reaching a
   * terminal state. A cancellation that was already requested resolves
   * safely to CANCELLED; any other expired ownership resolves conservatively
   * to STALE — no verdict is ever invented during recovery.
   */
  async recoverStaleReviews(actor = "local-review-runtime"): Promise<number> {
    const now = this.clock.now();
    const candidates = await this.database.reviewRequest.findMany({ where: { status: { in: ["CLAIMED", "RUNNING", "CANCELLATION_REQUESTED"] }, leaseExpiresAt: { lt: now } } });
    let recovered = 0;
    for (const row of candidates) {
      const target = row.cancellationRequestedAt ? "CANCELLED" : "STALE";
      const applied = await this.database.$transaction(async tx => {
        const updated = await tx.reviewRequest.updateMany({
          where: { id: row.id, status: row.status, leaseExpiresAt: { lt: now } },
          data: {
            status: target, finishedAt: now,
            ...(target === "STALE" ? { invalidatedAt: now, failureCode: "STALE_LEASE", failureMessage: "Runtime ownership expired before a terminal result was recorded." } : {}),
            ...RELEASED_LEASE_FIELDS
          }
        });
        if (!updated.count) return false;
        await this.appendEventTx(tx, row.id, target === "CANCELLED" ? "REVIEW_CANCELLED" : "REVIEW_STALE_LEASE_RECOVERED", target === "CANCELLED" ? "INFO" : "WARNING",
          target === "CANCELLED" ? "Cancellation-requested review was recovered as cancelled after runtime ownership expired." : "Stale runtime ownership was recovered conservatively; no verdict was invented.");
        await tx.auditEvent.create({ data: {
          id: randomUUID(), projectId: row.projectId, taskId: row.taskId, executionSessionId: row.executionSessionId, actor,
          action: "REVIEW_STALE_RECOVERY", riskLevel: "REVIEW", detailsJson: this.boundedPayload({ reviewRequestId: row.id, recoveredAs: target })
        } });
        return true;
      });
      if (applied && row.ownerId) {
        // Never reattach to or assume the prior owner's process is dead based
        // on PID/lease-expiry alone: if that owner's invocation is still
        // PREPARING (the only non-terminal state createOwnedInvocationOrThrow
        // ever leaves a row in), it is CAS-updated to INTERRUPTED_UNCERTAIN
        // (not silently left PREPARING forever, and never a terminal status
        // implying a proven outcome) so requestReview's quarantine check
        // blocks a new authoritative request until this is resolved. If no
        // invocation row exists at all, reviewer.review() was never called
        // for this request (it crashed before createOwnedInvocationOrThrow
        // ever succeeded) -- no process was ever spawned, so there is
        // nothing to quarantine at the invocation level, and this is a no-op.
        await this.finalizeInvocationStatus(row.id, { ownerId: row.ownerId, leaseToken: row.leaseToken ?? "", claimAttempt: row.claimAttempts }, "INTERRUPTED_UNCERTAIN");
      }
      if (applied) recovered += 1;
    }
    return recovered;
  }

  getReviewRequest(id: string): Promise<ReviewRequestDetails | null> {
    return this.database.reviewRequest.findUnique({ where: { id }, include: reviewInclude });
  }

  listReviewsForExecution(executionSessionId: string) {
    return this.database.reviewRequest.findMany({ where: { executionSessionId }, include: reviewInclude, orderBy: { createdAt: "desc" } });
  }

  /** Resolves an execution session's owning project, or null if it does not exist. Used to check ownership before touching any review row. */
  async getExecutionSessionProject(executionSessionId: string): Promise<string | null> {
    const session = await this.database.executionSession.findUnique({ where: { id: executionSessionId }, select: { projectId: true } });
    return session?.projectId ?? null;
  }

  listEvents(reviewRequestId: string, afterSequence = 0, limit = 100) {
    return this.database.reviewEvent.findMany({ where: { reviewRequestId, sequence: { gt: afterSequence } }, orderBy: { sequence: "asc" }, take: Math.min(Math.max(limit, 1), 250) });
  }

  /**
   * The single ReviewInvocation row for a review (schema-enforced UNIQUE on
   * reviewRequestId), or null if none has been created yet. Every field
   * returned here is already safe for the API/UI layer: a status enum, a
   * version string, and sha256 hex hashes -- never a raw executable path,
   * stdout/stderr, or credential.
   */
  async latestInvocation(reviewRequestId: string): Promise<{ status: string; reviewerId: string; cliVersion: string; reviewMaterialHash: string; promptHash: string; createdAt: Date } | null> {
    const invocation = await this.database.reviewInvocation.findUnique({ where: { reviewRequestId } });
    if (!invocation) return null;
    return { status: invocation.status, reviewerId: invocation.reviewerId, cliVersion: invocation.cliVersion, reviewMaterialHash: invocation.reviewMaterialHash, promptHash: invocation.promptHash, createdAt: invocation.createdAt };
  }

  /**
   * Authority-preserving projection of the latest non-cancelled review onto an
   * execution session. Never collapses to a plain verdict/status string — see
   * ReviewGateProjection and canSatisfyAuthoritativeReviewGate.
   */
  async reviewGateProjection(executionSessionId: string): Promise<ReviewGateProjection> {
    const latest = await this.database.reviewRequest.findFirst({
      where: { executionSessionId, status: { not: "CANCELLED" } },
      orderBy: { createdAt: "desc" },
      include: { verdicts: { orderBy: { createdAt: "desc" }, take: 1 } }
    });
    if (!latest) return { state: "NOT_REQUESTED", authority: "NONE", reviewerId: null, reviewRequestId: null, verdictId: null, requestHash: null, commitAuthorityEligible: false };
    return {
      state: GATE_STATE_BY_REQUEST_STATUS[reviewRequestStatusSchema.parse(latest.status)],
      authority: reviewAuthoritySchema.parse(latest.reviewAuthority),
      reviewerId: latest.reviewerId,
      reviewRequestId: latest.id,
      verdictId: latest.verdicts[0]?.id ?? null,
      requestHash: latest.requestHash,
      commitAuthorityEligible: false
    };
  }
}
