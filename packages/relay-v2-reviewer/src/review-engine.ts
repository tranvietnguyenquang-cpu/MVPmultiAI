import { randomUUID } from "node:crypto";
import { redactSecrets } from "@project-relay/local-safety";
import {
  REVIEW_POLICY_VERSION,
  assertReviewTransition,
  canonicalJson,
  fakeReviewerScenarioSchema,
  isTerminalReviewStatus,
  reviewAuthoritySchema,
  reviewRequestStatusSchema,
  reviewerSelectionSchema,
  structuredReviewVerdictSchema,
  type ReviewAuthority,
  type ReviewEventLevel,
  type ReviewEventType,
  type ReviewGateProjection,
  type ReviewGateState,
  type ReviewRequestStatus,
  type StructuredReviewVerdict
} from "@project-relay/relay-v2-domain";
import { Prisma, type RelayV2Database } from "@project-relay/relay-v2-persistence";
import { z } from "zod";
import { SystemReviewClock, type ReviewClock } from "./clock.js";
import {
  computeCanonicalTaskSpecHash,
  computeRequestHash,
  computeReviewInputHash,
  computeTaskNormalizedSpecHash,
  reviewInputCapsuleSchema,
  sha256Hex,
  verifyCapsuleIntegrity,
  verifyJsonHashBinding,
  type ReviewInputCapsule
} from "./review-binding.js";
import { resolveReviewerAuthority } from "./reviewer-authority.js";
import type { ImmutableReviewCapsule, RelayReviewer } from "./reviewer-contract.js";
import { ReviewerRegistry } from "./reviewer-registry.js";

/**
 * Every value that can affect RelayReviewer.review()'s behavior must be bound
 * by a schema here, keyed by reviewerId, so it participates in
 * reviewerConfigHash. Any reviewer id with no entry gets the strictest
 * possible schema (no configuration permitted at all) — a future reviewer
 * must deliberately register its own schema before it can accept any config.
 */
const REVIEWER_CONFIG_SCHEMA_BY_ID: Record<string, z.ZodTypeAny> = {
  "fake-reviewer": fakeReviewerScenarioSchema
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
type ArtifactRow = { artifactType: string; relativePath: string; sha256: string; byteCount: number; truncated: boolean };
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
};

export type RequestReviewOptions = {
  reviewerConfig?: unknown;
  diagnostic?: boolean;
};

export type RequestReviewResult = { reviewRequest: ReviewRequestDetails; duplicate: boolean };

/** The ownership generation a runtime host proved when it claimed a review. Every terminal write must re-prove this exact generation still holds. */
type ClaimOwnership = { ownerId: string; leaseToken: string; claimAttempt: number };

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
  private checkEligibility(session: SessionWithReviewContext): { reason: string } | null {
    if (session.status !== "SUCCEEDED") return { reason: `Execution session status is ${session.status}; only a succeeded execution can be reviewed.` };
    if (session.task.status !== "AWAITING_USER_ACCEPTANCE") return { reason: `Task status is ${session.task.status}; the execution has not reached AWAITING_USER_ACCEPTANCE.` };
    if (session.leases.some(lease => !lease.releasedAt)) return { reason: "The workspace lease for this execution has not been released." };
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
  private buildReviewInputCapsule(
    reviewRequestId: string, requestedAt: Date, session: SessionWithReviewContext, projectId: string,
    reviewerId: string, approval: ApprovalRow, reviewAuthority: ReviewAuthority, diagnostic: boolean
  ): ReviewInputCapsule {
    const { branch, head } = finalBranchHead(session.finalEvidenceJson);
    return reviewInputCapsuleSchema.parse({
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
      requestedAt: requestedAt.toISOString(), reviewPolicyVersion: REVIEW_POLICY_VERSION
    });
  }

  private async auditRejected(session: SessionWithReviewContext, projectId: string, actor: string, reason: string) {
    await this.database.auditEvent.create({ data: {
      id: randomUUID(), projectId, taskId: session.taskId, executionSessionId: session.id, actor,
      action: "REVIEW_REQUEST_REJECTED", riskLevel: "REVIEW", detailsJson: this.boundedPayload({ reason })
    } });
  }

  async requestReview(executionSessionId: string, projectId: string, reviewerId: string, actor = "local-user", options: RequestReviewOptions = {}): Promise<RequestReviewResult> {
    const reviewer = this.reviewers.get(reviewerId);
    if (!reviewer) throw new ReviewAuthorityError(`Reviewer '${reviewerId}' is not registered in this runtime.`);

    const session = await this.database.executionSession.findUnique({ where: { id: executionSessionId }, include: sessionInclude });
    if (!session || session.projectId !== projectId) throw new ReviewNotFoundError("Execution session not found for this project.");

    const activeExisting = await this.database.reviewRequest.findFirst({ where: { executionSessionId, status: { in: [...ACTIVE_REVIEW_STATUSES] } }, include: reviewInclude });
    if (activeExisting) return { reviewRequest: activeExisting, duplicate: true };

    const eligibilityFailure = this.checkEligibility(session);
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

    const reviewRequestId = randomUUID();
    const requestedAt = this.clock.now();
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
        const capsule = this.buildReviewInputCapsule(reviewRequestId, requestedAt, session, projectId, reviewerId, approval, authority.mode, diagnosticRequested);
        const reviewInputHash = computeReviewInputHash(capsule);
        const requestHash = computeRequestHash({
          reviewInputHash, reviewerConfigHash, reviewerId, reviewAuthority: authority.mode,
          requestedBy: actor, attempt: priorAttempts, reviewPolicyVersion: capsule.reviewPolicyVersion
        });
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
          reviewerConfigJson, reviewerConfigHash, requestedBy: actor, requestedAt
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
  private async revalidateForVerdict(tx: Prisma.TransactionClient, row: ReviewRequestRow): Promise<{ ok: true } | { ok: false; reason: string; code: "REVIEW_IMMUTABLE_INPUT_MISMATCH" | "EVIDENCE_CHANGED" }> {
    const bindingCheck = this.verifyImmutableInputBinding(row);
    if (!bindingCheck.ok) return { ok: false, reason: bindingCheck.reason, code: "REVIEW_IMMUTABLE_INPUT_MISMATCH" };

    const session = await tx.executionSession.findUnique({ where: { id: row.executionSessionId }, include: sessionInclude });
    if (!session || session.projectId !== row.projectId) return { ok: false, code: "EVIDENCE_CHANGED", reason: "The execution session or its project ownership changed after the review was requested." };
    if (session.task.specHash !== session.approvedSpecHash) return { ok: false, code: "EVIDENCE_CHANGED", reason: "The task specification changed after this execution completed." };

    const eligibilityFailure = this.checkEligibility(session);
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

    const currentCapsule = this.buildReviewInputCapsule(row.id, row.requestedAt, session, row.projectId, row.reviewerId, approval, authority.mode, row.diagnosticRequested);
    const currentRequestHash = computeRequestHash({
      reviewInputHash: computeReviewInputHash(currentCapsule), reviewerConfigHash: row.reviewerConfigHash,
      reviewerId: row.reviewerId, reviewAuthority: authority.mode, requestedBy: row.requestedBy, attempt: row.attempt, reviewPolicyVersion: row.reviewPolicyVersion
    });
    if (currentRequestHash !== row.requestHash) {
      return { ok: false, code: "EVIDENCE_CHANGED", reason: "The review requestHash no longer matches a freshly reconstructed input capsule." };
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

      const revalidation = await this.revalidateForVerdict(tx, row);
      await this.appendEventTx(tx, reviewRequestId, "REVIEW_EVIDENCE_RECHECKED", "INFO", "Revalidated authority and evidence bindings before accepting the verdict.");

      if (!revalidation.ok) {
        const staled = await tx.reviewRequest.updateMany({
          where: this.ownershipWhere(reviewRequestId, ownership, "RUNNING", now),
          data: { status: "STALE", finishedAt: now, invalidatedAt: now, failureCode: revalidation.code, failureMessage: redactSecrets(revalidation.reason).slice(0, 2_000), ...RELEASED_LEASE_FIELDS }
        });
        if (!staled.count) return "ownership-lost" as const;
        await this.appendEventTx(tx, reviewRequestId, "REVIEW_STALE_INVALIDATED", "WARNING", revalidation.reason);
        await tx.auditEvent.create({ data: {
          id: randomUUID(), projectId: row.projectId, taskId: row.taskId, executionSessionId: row.executionSessionId, actor: "review-engine",
          action: "REVIEW_STALE_INVALIDATED", riskLevel: "REVIEW", detailsJson: this.boundedPayload({ reviewRequestId, reason: revalidation.reason })
        } });
        return "stale" as const;
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
    const heartbeatTimer = setInterval(() => void this.heartbeat(reviewRequestId, leaseToken), Math.max(25, Math.floor(this.leaseMs / 3)));
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

      // The reviewer receives exactly the validated, persisted, hash-bound
      // capsule and its validated, persisted, hash-bound configuration —
      // never task/execution fields re-assembled from live rows at run time,
      // and never a reviewer configuration appended unbound.
      const capsule: ImmutableReviewCapsule = {
        ...bindingCheck.capsule,
        requestHash: row.requestHash,
        ...(reviewer.id === "fake-reviewer" ? { scenario: fakeReviewerScenarioSchema.parse(bindingCheck.reviewerConfig) } : {})
      };

      let rawVerdict: StructuredReviewVerdict;
      try {
        rawVerdict = await reviewer.review(capsule, { signal: controller.signal, now: () => this.clock.now(), sleep: milliseconds => this.clock.sleep(milliseconds, controller.signal) });
      } catch (error) {
        const current = await this.database.reviewRequest.findUnique({ where: { id: reviewRequestId }, select: { status: true } });
        if (controller.signal.aborted || current?.status === "CANCELLATION_REQUESTED" || current?.status === "CANCELLED") {
          await this.resolveFinalizationRace(reviewRequestId, ownership);
          return;
        }
        await this.finalizeNonVerdict(reviewRequestId, ownership, "RUNNING", "ERROR", "The reviewer failed to produce a result.", "ERROR", error instanceof Error ? error.message : String(error));
        return;
      }
      await this.appendEvent(reviewRequestId, "REVIEWER_OUTPUT_RECEIVED", "INFO", "The reviewer produced a structured result.");

      const parsedVerdict = structuredReviewVerdictSchema.safeParse(rawVerdict);
      if (!parsedVerdict.success) {
        await this.finalizeNonVerdict(reviewRequestId, ownership, "RUNNING", "ERROR", "Reviewer output failed structured validation.", "ERROR", parsedVerdict.error.issues.map(issue => issue.message).join("; "));
        return;
      }
      if (parsedVerdict.data.reviewedRequestHash !== row.requestHash) {
        await this.finalizeNonVerdict(reviewRequestId, ownership, "RUNNING", "ERROR", "Reviewer output does not reference the requested review's hash.", "ERROR", "reviewedRequestHash mismatch");
        return;
      }

      await this.finalizeAcceptedVerdict(reviewRequestId, ownership, parsedVerdict.data);
    } finally {
      clearInterval(heartbeatTimer);
      this.controllers.delete(reviewRequestId);
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
