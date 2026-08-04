import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canSatisfyAuthoritativeReviewGate, canonicalJson, fakeReviewerScenarioSchema, parseHandoffText, untruncatedProvenance, type NormalizedTaskSpec } from "@project-relay/relay-v2-domain";
import { createDisposableRelayV2Database } from "@project-relay/relay-v2-persistence/testing";
import { RelayV2Orchestrator } from "@project-relay/relay-v2-orchestrator";
import { ExecutionArtifactStore, ExecutionEngine, FakeExecutor } from "@project-relay/relay-v2-execution";
import { FakeReviewer } from "./fake-reviewer.js";
import { computeRequestHash, computeReviewInputHash, reviewInputCapsuleSchema, sha256Hex, type ReviewInputCapsule } from "./review-binding.js";
import { ReviewAuthorityError, ReviewEngine, ReviewNotFoundError } from "./review-engine.js";
import type { ImmutableReviewCapsule, RelayReviewer, ReviewControls, ReviewerHealth, ReviewerValidationRequest, ReviewerValidationResult } from "./reviewer-contract.js";
import { ReviewRuntimeHost } from "./runtime-host.js";
import type { ReviewerDescriptor, StructuredReviewVerdict } from "@project-relay/relay-v2-domain";
import { EMPTY_EXECUTION_LOG_EVIDENCE } from "./review-binding.js";

/** Builds a self-referentially-consistent capsuleJson/capsuleHash pair, matching how buildExecutionCapsule embeds its own hash. */
function selfConsistentCapsule(sessionId: string): { capsuleHash: string; capsuleJson: string } {
  const withoutHash = { sessionId };
  const capsuleHash = sha256Hex(canonicalJson(withoutHash));
  return { capsuleHash, capsuleJson: canonicalJson({ ...withoutHash, capsuleHash }) };
}

/** Builds a strictly-valid, self-consistent persisted baseline `GitEvidence` JSON string, matching WorkspaceEvidenceService.capture's shape closely enough to pass the strict evidence schema in review-binding.ts. */
function validBaselineGitEvidenceJson(): string {
  const withoutHash = {
    repositoryRoot: "C:/fixture-repo", branch: "main", head: "a".repeat(40), dirty: false,
    status: [], stagedCount: 0, unstagedCount: 0, untrackedCount: 0,
    patchPreview: "", patchSha256: sha256Hex(""), patchTruncated: false, patchProvenance: untruncatedProvenance(""), patchOmittedForSensitivePaths: false
  };
  return canonicalJson({ ...withoutHash, capturedAt: "2026-08-03T00:00:00.000Z", evidenceHash: sha256Hex(canonicalJson(withoutHash)) });
}

/** Builds a strictly-valid, self-consistent persisted final `{ evidence, delta }` envelope JSON string, matching what ExecutionEngine persists into finalEvidenceJson. */
function validFinalGitEvidenceJson(): string {
  const withoutHash = {
    repositoryRoot: "C:/fixture-repo", branch: "main", head: "b".repeat(40), dirty: false,
    status: [], stagedCount: 0, unstagedCount: 0, untrackedCount: 0,
    patchPreview: "", patchSha256: sha256Hex(""), patchTruncated: false, patchProvenance: untruncatedProvenance(""), patchOmittedForSensitivePaths: false
  };
  const evidence = { ...withoutHash, capturedAt: "2026-08-03T00:00:00.000Z", evidenceHash: sha256Hex(canonicalJson(withoutHash)) };
  const delta = {
    baselineHash: "a".repeat(64), finalHash: evidence.evidenceHash, changedFiles: [],
    headChanged: false, branchChanged: false, preExistingChangesDestroyed: [], preExistingChangesHidden: [],
    unaccountedPreExistingPaths: [], stashChanged: false, forbiddenGitMutationSuspected: false
  };
  return canonicalJson({ evidence, delta });
}

/** Delegates to a real FakeReviewer but records the exact capsule object it was handed, so tests can assert the reviewer received nothing beyond the persisted reviewInputJson. */
class CapturingReviewer implements RelayReviewer {
  readonly id = "fake-reviewer";
  private readonly inner = new FakeReviewer();
  lastCapsule: ImmutableReviewCapsule | undefined;
  describe(): ReviewerDescriptor { return this.inner.describe(); }
  async validate(request: ReviewerValidationRequest): Promise<ReviewerValidationResult> { return this.inner.validate(request); }
  async review(capsule: ImmutableReviewCapsule, controls: ReviewControls): Promise<StructuredReviewVerdict> {
    this.lastCapsule = capsule;
    return this.inner.review(capsule, controls);
  }
  async cancel(reviewRequestId: string): Promise<void> { return this.inner.cancel(reviewRequestId); }
  async health(): Promise<ReviewerHealth> { return this.inner.health(); }
}

/**
 * Builds a fully self-consistent ReviewRequest row (matching exactly what
 * requestReview would have produced) referencing a real executionSessionId/
 * projectId/taskId, but constructed by hand so a test can deliberately
 * corrupt exactly one field before inserting — simulating a corrupt,
 * imported, or legacy row that never went through ReviewEngine.requestReview.
 * requestedAt is pinned to the epoch so claimNext (oldest-first) always picks
 * this row over any other PENDING row that might exist in the shared test
 * database.
 */
function buildSelfConsistentReviewRequestFixture(params: { reviewRequestId: string; executionSessionId: string; projectId: string; taskId: string }) {
  const requestedAt = new Date(0);
  const requestedBy = "tester";
  const attempt = 0;
  const capsule: ReviewInputCapsule = reviewInputCapsuleSchema.parse({
    reviewRequestId: params.reviewRequestId, executionSessionId: params.executionSessionId, projectId: params.projectId, taskId: params.taskId,
    reviewerId: "fake-reviewer", reviewAuthority: "DIAGNOSTIC", diagnostic: true,
    approvalId: crypto.randomUUID(), approvalStatus: "APPROVED", approvedReviewer: "CLAUDE", taskSelectedReviewer: "CLAUDE", executionExecutorId: "fake",
    taskTitle: "Fixture task", taskObjective: "Fixture objective", taskContext: "",
    taskSpecHash: "a".repeat(64), canonicalTaskSpecHash: "a".repeat(64), taskNormalizedSpecHash: "a".repeat(64), approvalSnapshotHash: "a".repeat(64),
    executionStatus: "SUCCEEDED", executionResultStatus: "succeeded", executionSummary: "ok", executionSummaryHash: sha256Hex("ok"),
    executionCapsuleHash: sha256Hex("{}"), executionCapsuleJsonHash: sha256Hex("{}"),
    baselineGitEvidenceHash: "a".repeat(64), finalGitEvidenceHash: "a".repeat(64), verificationResultsHash: "a".repeat(64), executionArtifactSetHash: "a".repeat(64),
    finalBranch: "main", finalHead: "deadbeef", requestedAt: requestedAt.toISOString(), reviewPolicyVersion: "2.3A-v1",
    taskConstraints: [], acceptanceCriteria: [],
    approvedExecutorSelection: "FAKE", approvedModel: "AUTO", approvedEffort: "AUTO", approvedVerificationOperations: [],
    baselineGitEvidence: { available: false, branch: "", head: "", dirty: false, changedFiles: [], diffPreview: "", diffTruncated: false, diffOmittedForSensitivePaths: false },
    finalGitEvidence: { available: false, branch: "", head: "", dirty: false, changedFiles: [], diffPreview: "", diffTruncated: false, diffOmittedForSensitivePaths: false },
    verificationEvidence: [], executionArtifactManifest: [],
    executionLogEvidence: EMPTY_EXECUTION_LOG_EVIDENCE
  });
  const reviewInputJson = canonicalJson(capsule);
  const reviewInputHash = computeReviewInputHash(capsule);
  const reviewerConfig = fakeReviewerScenarioSchema.parse({ outcome: "approve" });
  const reviewerConfigJson = canonicalJson(reviewerConfig);
  const reviewerConfigHash = sha256Hex(reviewerConfigJson);
  const requestHash = computeRequestHash({
    reviewInputHash, reviewerConfigHash, reviewerId: capsule.reviewerId, reviewAuthority: capsule.reviewAuthority,
    requestedBy, attempt, reviewPolicyVersion: capsule.reviewPolicyVersion
  });
  return {
    capsule, reviewInputJson, reviewInputHash, reviewerConfigJson, reviewerConfigHash, requestHash,
    data: {
      id: params.reviewRequestId, executionSessionId: params.executionSessionId, projectId: params.projectId, taskId: params.taskId,
      reviewerId: capsule.reviewerId, reviewAuthority: capsule.reviewAuthority, diagnosticRequested: true,
      approvalId: capsule.approvalId, approvalStatus: capsule.approvalStatus, approvalReviewerSelection: capsule.approvedReviewer, taskSelectedReviewer: capsule.taskSelectedReviewer,
      executionExecutorId: capsule.executionExecutorId, status: "PENDING", attempt,
      taskSpecHash: capsule.taskSpecHash, approvalSnapshotHash: capsule.approvalSnapshotHash, executionCapsuleHash: capsule.executionCapsuleHash,
      baselineGitEvidenceHash: capsule.baselineGitEvidenceHash, finalGitEvidenceHash: capsule.finalGitEvidenceHash, verificationResultsHash: capsule.verificationResultsHash,
      executionArtifactSetHash: capsule.executionArtifactSetHash, executionResultStatus: capsule.executionResultStatus, finalBranch: capsule.finalBranch, finalHead: capsule.finalHead,
      reviewPolicyVersion: capsule.reviewPolicyVersion, reviewInputJson, reviewInputHash, reviewerConfigJson, reviewerConfigHash, requestHash,
      requestedBy, requestedAt
    }
  };
}

const TERMINAL = ["APPROVED", "REJECTED", "NEEDS_CHANGES", "ERROR", "CANCELLED", "STALE"];

const handoff = {
  version: 1,
  project: { name: "Review Test" },
  task: { title: "Review fake work", objective: "Exercise the provider-neutral review engine", taskType: "implementation", complexity: "normal" },
  constraints: ["Do not modify source files"],
  acceptanceCriteria: ["Fake execution reaches a validated result"],
  execution: { executor: "fake", model: "auto", effort: "medium", reviewer: "claude", requireApproval: true, allowSourceTransmissionToApi: false }
};

function sleep(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }

describe("Relay v2 review engine", () => {
  let database: Awaited<ReturnType<typeof createDisposableRelayV2Database>>;
  let orchestrator: RelayV2Orchestrator;
  let executionEngine: ExecutionEngine;
  let reviewEngine: ReviewEngine;
  let workspace: string;
  let projectId: string;
  let counter = 0;

  beforeAll(async () => {
    database = await createDisposableRelayV2Database();
    orchestrator = new RelayV2Orchestrator(database.client);
    workspace = await mkdtemp(path.join(tmpdir(), "relay-v2-review-workspace-"));
    await mkdir(path.join(workspace, ".git"));
    projectId = (await orchestrator.createProject({ name: "Review Test", localPath: workspace })).id;
    executionEngine = new ExecutionEngine(database.client, new FakeExecutor(), new ExecutionArtifactStore(database.paths.artifactsDir, 1_024), { timeoutMs: 5_000, leaseMs: 5_000 });
    reviewEngine = new ReviewEngine(database.client, new FakeReviewer(), {
      allowFakeExecutorDiagnosticReviews: true, allowCodexTestDoubleDiagnosticReviews: true, leaseMs: 2_000
    });
  }, 30_000);

  afterAll(async () => {
    await database.cleanup();
    await rm(workspace, { recursive: true, force: true });
  });

  function spec(): NormalizedTaskSpec { return parseHandoffText(JSON.stringify(handoff)).normalized; }

  async function succeededSession(outcome: "success" | "failure" = "success") {
    counter += 1;
    const created = await orchestrator.createPendingTask({ projectId, normalized: spec(), source: "MANUAL", idempotencyKey: `review-${counter}` });
    await orchestrator.approveTask(created.task.id, "test-approver");
    const request = await executionEngine.requestExecution(created.task.id, "test", { outcome, eventCount: 1, delayMs: 0 });
    const claim = await executionEngine.claimNext();
    await executionEngine.runClaimed(claim!.sessionId, claim!.leaseToken);
    return { sessionId: request.session.id, taskId: created.task.id };
  }

  /** Claims the next PENDING review and runs it to completion, awaiting the entire lifecycle synchronously. Returns null if nothing was claimable. */
  async function claimAndAwait(engine: ReviewEngine = reviewEngine, owner = "test-owner"): Promise<{ reviewRequestId: string; leaseToken: string } | null> {
    const claim = await engine.claimNext(owner);
    if (!claim) return null;
    await engine.runClaimed(claim.reviewRequestId, claim.leaseToken);
    return claim;
  }

  /** Claims the next PENDING review and starts running it in the background (not awaited), so the caller can race it with a cancellation or a mutation. */
  async function claimAndRunInBackground(engine: ReviewEngine = reviewEngine, owner = "test-owner"): Promise<{ reviewRequestId: string; leaseToken: string; done: Promise<void> } | null> {
    const claim = await engine.claimNext(owner);
    if (!claim) return null;
    return { ...claim, done: engine.runClaimed(claim.reviewRequestId, claim.leaseToken) };
  }

  async function waitForStatus(reviewRequestId: string, status: string, attempts = 200): Promise<void> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const current = await reviewEngine.getReviewRequest(reviewRequestId);
      if (current?.status === status) return;
      await sleep(2);
    }
    throw new Error(`Review request ${reviewRequestId} did not reach status ${status}.`);
  }

  describe("eligibility", () => {
    it("accepts a succeeded diagnostic FakeExecutor session", async () => {
      const { sessionId } = await succeededSession();
      const result = await reviewEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "approve" } });
      expect(result.duplicate).toBe(false);
      expect(result.reviewRequest.status).toBe("PENDING");
      expect(result.reviewRequest.reviewAuthority).toBe("DIAGNOSTIC");
      await claimAndAwait();
      const terminal = await reviewEngine.getReviewRequest(result.reviewRequest.id);
      expect(terminal!.status).toBe("APPROVED");
    });

    it("rejects a session that has not reached AWAITING_USER_ACCEPTANCE (still running)", async () => {
      counter += 1;
      const created = await orchestrator.createPendingTask({ projectId, normalized: spec(), source: "MANUAL", idempotencyKey: `review-running-${counter}` });
      await orchestrator.approveTask(created.task.id, "test-approver");
      const request = await executionEngine.requestExecution(created.task.id, "test", { outcome: "success", eventCount: 1, delayMs: 5_000 });
      await expect(reviewEngine.requestReview(request.session.id, projectId, "fake-reviewer", "tester", { diagnostic: true })).rejects.toBeInstanceOf(ReviewAuthorityError);
      await executionEngine.cancelSession(request.session.id);
    });

    it("rejects a failed execution", async () => {
      const { sessionId } = await succeededSession("failure");
      await expect(reviewEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true })).rejects.toBeInstanceOf(ReviewAuthorityError);
    });

    it("rejects a non-diagnostic FakeExecutor request even when the engine allows diagnostics", async () => {
      const { sessionId } = await succeededSession();
      await expect(reviewEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester", {})).rejects.toThrow(/diagnostic request and the runtime diagnostic gate/i);
    });

    it("rejects when the workspace lease has not been released", async () => {
      const { sessionId } = await succeededSession();
      await database.client.workspaceLease.create({ data: {
        id: crypto.randomUUID(), workspaceKey: `synthetic-${sessionId}`, sessionId, leaseToken: crypto.randomUUID(),
        heartbeatAt: new Date(), expiresAt: new Date(Date.now() + 60_000)
      } });
      await expect(reviewEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true })).rejects.toThrow(/workspace lease/i);
    });

    it("rejects a missing execution capsule for a codex-marked session", async () => {
      const { sessionId } = await succeededSession();
      await database.client.executionSession.update({ where: { id: sessionId }, data: { executorId: "codex-cli", capsuleHash: null } });
      await expect(reviewEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester")).rejects.toThrow(/capsule/i);
    });

    it("rejects missing final Git evidence for a codex-marked session", async () => {
      const { sessionId } = await succeededSession();
      await database.client.executionSession.update({ where: { id: sessionId }, data: { executorId: "codex-cli", capsuleHash: "a".repeat(64), baselineEvidenceJson: validBaselineGitEvidenceJson() } });
      await expect(reviewEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester")).rejects.toThrow(/final git evidence/i);
    });

    it("rejects missing verification results when verification operations were required", async () => {
      const { sessionId } = await succeededSession();
      await database.client.executionSession.update({ where: { id: sessionId }, data: {
        executorId: "codex-cli", capsuleHash: "a".repeat(64), baselineEvidenceJson: validBaselineGitEvidenceJson(), finalEvidenceJson: validFinalGitEvidenceJson(),
        approvedVerificationJson: JSON.stringify(["NPM_TEST"])
      } });
      await expect(reviewEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester")).rejects.toThrow(/verification/i);
    });

    it("rejects a codex-marked session whose capsule fails self-referential integrity verification", async () => {
      const { sessionId } = await succeededSession();
      const capsuleHash = "a".repeat(64);
      await database.client.executionSession.update({ where: { id: sessionId }, data: {
        executorId: "codex-cli", capsuleHash, capsuleJson: JSON.stringify({ sessionId, capsuleHash: "b".repeat(64) }),
        baselineEvidenceJson: validBaselineGitEvidenceJson(), finalEvidenceJson: validFinalGitEvidenceJson()
      } });
      await expect(reviewEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester")).rejects.toThrow(/capsule failed integrity/i);
    });

    it("hard-rejects malformed (valid-JSON-wrong-shape) non-empty baseline Git evidence, never silently treating it as unavailable", async () => {
      // Genuinely non-parseable JSON can never reach here in the first place
      // (the column itself has a `CHECK (json_valid(...))` constraint, see
      // migration.sql) -- so the reachable malformed case through Prisma is
      // syntactically-valid-but-wrong-shape JSON (a bare scalar here), which
      // json_valid() does not and cannot catch.
      const { sessionId } = await succeededSession();
      await database.client.executionSession.update({ where: { id: sessionId }, data: { baselineEvidenceJson: "42" } });
      await expect(reviewEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true })).rejects.toThrow(/Git evidence is not a JSON object/i);
    });

    it("hard-rejects malformed (wrong-shape) non-empty final Git evidence", async () => {
      const { sessionId } = await succeededSession();
      await database.client.executionSession.update({ where: { id: sessionId }, data: { finalEvidenceJson: "[]" } });
      await expect(reviewEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true })).rejects.toThrow(/Git evidence is not a JSON object/i);
    });

    it("hard-rejects malformed (valid-JSON-wrong-shape) non-empty verification-results JSON, never silently treating it as zero results", async () => {
      const { sessionId } = await succeededSession();
      await database.client.executionSession.update({ where: { id: sessionId }, data: { verificationResultsJson: "{}" } });
      await expect(reviewEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true })).rejects.toThrow(/Verification results are not a JSON array/i);
    });

    it("returns not-found for a wrong project", async () => {
      const { sessionId } = await succeededSession();
      const otherWorkspace = await mkdtemp(path.join(tmpdir(), "relay-v2-review-other-"));
      await mkdir(path.join(otherWorkspace, ".git"));
      const otherProject = await orchestrator.createProject({ name: "Other Review Project", localPath: otherWorkspace });
      await expect(reviewEngine.requestReview(sessionId, otherProject.id, "fake-reviewer", "tester", { diagnostic: true })).rejects.toBeInstanceOf(ReviewNotFoundError);
    });

    it("returns the same active review for a concurrent duplicate request", async () => {
      const { sessionId } = await succeededSession();
      const [first, second] = await Promise.all([
        reviewEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "approve", delayMs: 20 } }),
        reviewEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "approve", delayMs: 20 } })
      ]);
      expect(new Set([first.reviewRequest.id, second.reviewRequest.id]).size).toBe(1);
      expect([first.duplicate, second.duplicate].filter(Boolean)).toHaveLength(1);
      await claimAndAwait();
    });
  });

  describe("reviewer authority", () => {
    it("rejects FakeReviewer for a real codex-cli session in normal runtime (diagnostic gate off)", async () => {
      const { sessionId } = await succeededSession();
      const capsule = selfConsistentCapsule(sessionId);
      await database.client.executionSession.update({ where: { id: sessionId }, data: {
        executorId: "codex-cli", ...capsule, baselineEvidenceJson: validBaselineGitEvidenceJson(), finalEvidenceJson: validFinalGitEvidenceJson()
      } });
      const normalRuntimeEngine = new ReviewEngine(database.client, new FakeReviewer(), { allowFakeExecutorDiagnosticReviews: true, allowCodexTestDoubleDiagnosticReviews: false });
      await expect(normalRuntimeEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true })).rejects.toThrow(/disposable test-double diagnostic gate/i);
    });

    it("accepts FakeReviewer for a codex-cli test-double session only when every diagnostic gate is on", async () => {
      const { sessionId } = await succeededSession();
      const capsule = selfConsistentCapsule(sessionId);
      await database.client.executionSession.update({ where: { id: sessionId }, data: {
        executorId: "codex-cli", ...capsule, baselineEvidenceJson: validBaselineGitEvidenceJson(), finalEvidenceJson: validFinalGitEvidenceJson()
      } });
      const result = await reviewEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "approve" } });
      expect(result.reviewRequest.reviewAuthority).toBe("DIAGNOSTIC");
      await claimAndAwait();
      const terminal = await reviewEngine.getReviewRequest(result.reviewRequest.id);
      expect(terminal!.status).toBe("APPROVED");
    });

    it("rejects a codex-cli test-double session when diagnostic was not explicitly requested, even with the gate on", async () => {
      const { sessionId } = await succeededSession();
      const capsule = selfConsistentCapsule(sessionId);
      await database.client.executionSession.update({ where: { id: sessionId }, data: {
        executorId: "codex-cli", ...capsule, baselineEvidenceJson: validBaselineGitEvidenceJson(), finalEvidenceJson: validFinalGitEvidenceJson()
      } });
      await expect(reviewEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester", {})).rejects.toThrow(/disposable test-double diagnostic gate/i);
    });

    it("rejects reviewer selection NONE", async () => {
      const { sessionId, taskId } = await succeededSession();
      await database.client.task.update({ where: { id: taskId }, data: { reviewer: "NONE" } });
      await database.client.approval.updateMany({ where: { taskId }, data: { reviewer: "NONE" } });
      await expect(reviewEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true })).rejects.toThrow(/NONE cannot authorize/);
    });

    it("invalidates authority when the task's reviewer selection changed since approval without a new approval", async () => {
      const { sessionId, taskId } = await succeededSession();
      await database.client.task.update({ where: { id: taskId }, data: { reviewer: "CODEX" } });
      await expect(reviewEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true })).rejects.toThrow(/changed since approval/);
    });

    it("rejects when the approval used for this execution is not APPROVED", async () => {
      const { sessionId, taskId } = await succeededSession();
      await database.client.approval.updateMany({ where: { taskId }, data: { status: "INVALIDATED" } });
      await expect(reviewEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true })).rejects.toThrow(/not APPROVED/);
    });

    it("a diagnostic verdict can never become authoritative: reviewAuthority is immutable once terminal", async () => {
      const { sessionId } = await succeededSession();
      const result = await reviewEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "approve" } });
      await claimAndAwait();
      const terminal = await reviewEngine.getReviewRequest(result.reviewRequest.id);
      expect(terminal!.reviewAuthority).toBe("DIAGNOSTIC");
      await expect(database.client.reviewRequest.update({ where: { id: result.reviewRequest.id }, data: { reviewAuthority: "AUTHORITATIVE" } })).rejects.toThrow();
    });
  });

  describe("evidence binding and staleness", () => {
    it("invalidates the review when final Git evidence changes before the verdict is accepted", async () => {
      const { sessionId } = await succeededSession();
      const result = await reviewEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "approve", delayMs: 30 } });
      const claim = await claimAndRunInBackground();
      await database.client.executionSession.update({ where: { id: sessionId }, data: { finalEvidenceJson: JSON.stringify({ evidence: { branch: "main", head: "mutated" } }) } });
      await claim!.done;
      const terminal = await reviewEngine.getReviewRequest(result.reviewRequest.id);
      expect(terminal!.status).toBe("STALE");
      expect(terminal!.verdicts).toHaveLength(0);
    });

    it("invalidates the review when verification results change before the verdict is accepted", async () => {
      const { sessionId } = await succeededSession();
      const result = await reviewEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "approve", delayMs: 30 } });
      const claim = await claimAndRunInBackground();
      await database.client.executionSession.update({ where: { id: sessionId }, data: { verificationResultsJson: JSON.stringify([{ operation: "NPM_TEST", passed: true }]) } });
      await claim!.done;
      const terminal = await reviewEngine.getReviewRequest(result.reviewRequest.id);
      expect(terminal!.status).toBe("STALE");
    });

    it("invalidates (never approves) the review when Git evidence becomes malformed (valid-JSON-wrong-shape) non-empty JSON after the request but before the verdict is accepted", async () => {
      const { sessionId } = await succeededSession();
      const result = await reviewEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "approve", delayMs: 30 } });
      const claim = await claimAndRunInBackground();
      await database.client.executionSession.update({ where: { id: sessionId }, data: { finalEvidenceJson: "42" } });
      await claim!.done;
      const terminal = await reviewEngine.getReviewRequest(result.reviewRequest.id);
      expect(terminal!.status).toBe("STALE");
      expect(terminal!.verdicts).toHaveLength(0);
    });

    it("invalidates the review when the execution capsule changes before the verdict is accepted", async () => {
      const { sessionId } = await succeededSession();
      const result = await reviewEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "approve", delayMs: 30 } });
      const claim = await claimAndRunInBackground();
      await database.client.executionSession.update({ where: { id: sessionId }, data: { capsuleJson: JSON.stringify({ mutated: true }) } });
      await claim!.done;
      const terminal = await reviewEngine.getReviewRequest(result.reviewRequest.id);
      expect(terminal!.status).toBe("STALE");
    });

    it("invalidates the review when the task status changes before the verdict is accepted", async () => {
      const { sessionId, taskId } = await succeededSession();
      const result = await reviewEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "approve", delayMs: 30 } });
      const claim = await claimAndRunInBackground();
      await database.client.task.update({ where: { id: taskId }, data: { status: "CANCELLED" } });
      await claim!.done;
      const terminal = await reviewEngine.getReviewRequest(result.reviewRequest.id);
      expect(terminal!.status).toBe("STALE");
    });

    it("invalidates the review when the execution status changes before the verdict is accepted", async () => {
      const { sessionId } = await succeededSession();
      const result = await reviewEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "approve", delayMs: 30 } });
      const claim = await claimAndRunInBackground();
      await database.client.executionSession.update({ where: { id: sessionId }, data: { status: "FAILED" } });
      await claim!.done;
      const terminal = await reviewEngine.getReviewRequest(result.reviewRequest.id);
      expect(terminal!.status).toBe("STALE");
    });

    it("invalidates the review when the approval is invalidated before the verdict is accepted", async () => {
      const { sessionId, taskId } = await succeededSession();
      const result = await reviewEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "approve", delayMs: 30 } });
      const claim = await claimAndRunInBackground();
      await database.client.approval.updateMany({ where: { taskId }, data: { status: "INVALIDATED" } });
      await claim!.done;
      const terminal = await reviewEngine.getReviewRequest(result.reviewRequest.id);
      expect(terminal!.status).toBe("STALE");
    });

    it("invalidates the review when the workspace lease becomes active again before the verdict is accepted", async () => {
      const { sessionId } = await succeededSession();
      const result = await reviewEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "approve", delayMs: 30 } });
      const claim = await claimAndRunInBackground();
      await database.client.workspaceLease.create({ data: {
        id: crypto.randomUUID(), workspaceKey: `synthetic-relock-${sessionId}`, sessionId, leaseToken: crypto.randomUUID(),
        heartbeatAt: new Date(), expiresAt: new Date(Date.now() + 60_000)
      } });
      await claim!.done;
      const terminal = await reviewEngine.getReviewRequest(result.reviewRequest.id);
      expect(terminal!.status).toBe("STALE");
    });

    it("does not go stale when evidence is untouched", async () => {
      const { sessionId } = await succeededSession();
      const result = await reviewEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "approve", delayMs: 10 } });
      await claimAndAwait();
      const terminal = await reviewEngine.getReviewRequest(result.reviewRequest.id);
      expect(terminal!.status).toBe("APPROVED");
    });
  });

  describe("reviewer input binding (finding 1 & 2)", () => {
    it("invalidates the review when the task title changes before the verdict is accepted", async () => {
      const { sessionId, taskId } = await succeededSession();
      const result = await reviewEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "approve", delayMs: 30 } });
      const claim = await claimAndRunInBackground();
      await database.client.task.update({ where: { id: taskId }, data: { title: "A different title" } });
      await claim!.done;
      const terminal = await reviewEngine.getReviewRequest(result.reviewRequest.id);
      expect(terminal!.status).toBe("STALE");
      expect(terminal!.verdicts).toHaveLength(0);
    });

    it("invalidates the review when the task objective changes before the verdict is accepted", async () => {
      const { sessionId, taskId } = await succeededSession();
      const result = await reviewEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "approve", delayMs: 30 } });
      const claim = await claimAndRunInBackground();
      await database.client.task.update({ where: { id: taskId }, data: { objective: "A different objective" } });
      await claim!.done;
      const terminal = await reviewEngine.getReviewRequest(result.reviewRequest.id);
      expect(terminal!.status).toBe("STALE");
    });

    it("invalidates the review when the execution summary changes before the verdict is accepted", async () => {
      const { sessionId } = await succeededSession();
      const result = await reviewEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "approve", delayMs: 30 } });
      const claim = await claimAndRunInBackground();
      await database.client.executionSession.update({ where: { id: sessionId }, data: { summary: "A different summary." } });
      await claim!.done;
      const terminal = await reviewEngine.getReviewRequest(result.reviewRequest.id);
      expect(terminal!.status).toBe("STALE");
    });

    it("invalidates the review when the normalized task specification changes without the specHash column changing", async () => {
      const { sessionId, taskId } = await succeededSession();
      const result = await reviewEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "approve", delayMs: 30 } });
      const claim = await claimAndRunInBackground();
      const task = await database.client.task.findUniqueOrThrow({ where: { id: taskId } });
      const mutatedSpec = { ...JSON.parse(task.normalizedSpecJson) as Record<string, unknown>, acceptanceCriteria: ["Mutated acceptance criterion"] };
      await database.client.task.update({ where: { id: taskId }, data: { normalizedSpecJson: JSON.stringify(mutatedSpec) } });
      await claim!.done;
      const terminal = await reviewEngine.getReviewRequest(result.reviewRequest.id);
      expect(terminal!.status).toBe("STALE");
    });

    it("rejects a request when the approval's approvedSpecJson was tampered independent of its own specHash field", async () => {
      const { sessionId, taskId } = await succeededSession();
      const approval = await database.client.approval.findFirstOrThrow({ where: { taskId, status: "APPROVED" } });
      const parsed = JSON.parse(approval.approvedSpecJson) as { task: { task: { title: string } } };
      parsed.task.task.title = "Tampered title, specHash left untouched";
      await database.client.approval.update({ where: { id: approval.id }, data: { approvedSpecJson: JSON.stringify(parsed) } });
      await expect(reviewEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true })).rejects.toThrow(/integrity/i);
    });

    it("gives the reviewer exactly the persisted reviewInputJson and nothing appended separately", async () => {
      const { sessionId } = await succeededSession();
      const capturing = new CapturingReviewer();
      const capturingEngine = new ReviewEngine(database.client, capturing, { allowFakeExecutorDiagnosticReviews: true, leaseMs: 2_000 });
      const result = await capturingEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "approve" } });
      const claim = await capturingEngine.claimNext("capture-owner");
      await capturingEngine.runClaimed(claim!.reviewRequestId, claim!.leaseToken);
      const row = await database.client.reviewRequest.findUniqueOrThrow({ where: { id: result.reviewRequest.id } });
      expect(capturing.lastCapsule).toBeDefined();
      const persisted = JSON.parse(row.reviewInputJson) as Record<string, unknown>;
      const { requestHash, reviewInputHash, reviewerConfigHash, scenario, ...receivedInput } = capturing.lastCapsule!;
      void scenario;
      expect(receivedInput).toEqual(persisted);
      expect(requestHash).toBe(row.requestHash);
      expect(reviewInputHash).toBe(row.reviewInputHash);
      expect(reviewerConfigHash).toBe(row.reviewerConfigHash);
    });
  });

  describe("verdict outcomes and state machine", () => {
    it("records an APPROVE verdict with no blocking findings", async () => {
      const { sessionId } = await succeededSession();
      const result = await reviewEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "approve" } });
      await claimAndAwait();
      const terminal = await reviewEngine.getReviewRequest(result.reviewRequest.id);
      expect(terminal!.status).toBe("APPROVED");
      expect(terminal!.verdicts[0]?.verdict).toBe("APPROVE");
    });

    it("records a REJECT verdict with a blocking finding", async () => {
      const { sessionId } = await succeededSession();
      const result = await reviewEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "reject" } });
      await claimAndAwait();
      const terminal = await reviewEngine.getReviewRequest(result.reviewRequest.id);
      expect(terminal!.status).toBe("REJECTED");
      expect(JSON.parse(terminal!.verdicts[0]!.findingsJson)).not.toHaveLength(0);
    });

    it("records a NEEDS_CHANGES verdict with a required action", async () => {
      const { sessionId } = await succeededSession();
      const result = await reviewEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "needs_changes" } });
      await claimAndAwait();
      const terminal = await reviewEngine.getReviewRequest(result.reviewRequest.id);
      expect(terminal!.status).toBe("NEEDS_CHANGES");
      expect(JSON.parse(terminal!.verdicts[0]!.requiredActionsJson).length).toBeGreaterThan(0);
    });

    it("turns an invalid structured reviewer response into ERROR, never APPROVE", async () => {
      const { sessionId } = await succeededSession();
      const result = await reviewEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "invalid" } });
      await claimAndAwait();
      const terminal = await reviewEngine.getReviewRequest(result.reviewRequest.id);
      expect(terminal!.status).toBe("ERROR");
      expect(terminal!.verdicts).toHaveLength(0);
    });

    it("turns a reviewer failure into ERROR", async () => {
      const { sessionId } = await succeededSession();
      const result = await reviewEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "failure" } });
      await claimAndAwait();
      const terminal = await reviewEngine.getReviewRequest(result.reviewRequest.id);
      expect(terminal!.status).toBe("ERROR");
    });

    it("cancels a pending review before it is claimed", async () => {
      const { sessionId } = await succeededSession();
      const result = await reviewEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "cancellation" } });
      const outcome = await reviewEngine.cancelReview(result.reviewRequest.id, "tester");
      expect(outcome.alreadyTerminal).toBe(false);
      expect(outcome.reviewRequest!.status).toBe("CANCELLED");
    });

    it("cancels a running review", async () => {
      const { sessionId } = await succeededSession();
      const result = await reviewEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "cancellation", delayMs: 5 } });
      const claim = await claimAndRunInBackground();
      await waitForStatus(result.reviewRequest.id, "RUNNING");
      await reviewEngine.cancelReview(result.reviewRequest.id, "tester");
      await claim!.done;
      const terminal = await reviewEngine.getReviewRequest(result.reviewRequest.id);
      expect(terminal!.status).toBe("CANCELLED");
    });

    it("treats cancelling an already-terminal review as a no-op", async () => {
      const { sessionId } = await succeededSession();
      const result = await reviewEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "approve" } });
      await claimAndAwait();
      const outcome = await reviewEngine.cancelReview(result.reviewRequest.id, "tester");
      expect(outcome.alreadyTerminal).toBe(true);
    });

    it("creates a new attempt after a prior terminal review for the same session", async () => {
      const { sessionId } = await succeededSession();
      const first = await reviewEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "approve" } });
      await claimAndAwait();
      const second = await reviewEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "reject" } });
      expect(second.duplicate).toBe(false);
      expect(second.reviewRequest.id).not.toBe(first.reviewRequest.id);
      expect(second.reviewRequest.attempt).toBe(first.reviewRequest.attempt + 1);
      await claimAndAwait();
    });
  });

  describe("cancellation and finalization races (CAS)", () => {
    it("cancel CAS wins: a verdict cannot be inserted once cancellation was already requested", async () => {
      const { sessionId } = await succeededSession();
      // long delay so we can request cancellation well before the reviewer resolves
      const result = await reviewEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "approve", delayMs: 40 } });
      const claim = await claimAndRunInBackground();
      await waitForStatus(result.reviewRequest.id, "RUNNING");
      await reviewEngine.cancelReview(result.reviewRequest.id, "tester");
      await claim!.done;
      const terminal = await reviewEngine.getReviewRequest(result.reviewRequest.id);
      expect(terminal!.status).toBe("CANCELLED");
      expect(terminal!.verdicts).toHaveLength(0);
    });

    it("verdict CAS wins: cancelling after a terminal verdict was already recorded returns alreadyTerminal and cannot alter it", async () => {
      const { sessionId } = await succeededSession();
      const result = await reviewEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "approve" } });
      await claimAndAwait();
      const outcome = await reviewEngine.cancelReview(result.reviewRequest.id, "tester");
      expect(outcome.alreadyTerminal).toBe(true);
      const terminal = await reviewEngine.getReviewRequest(result.reviewRequest.id);
      expect(terminal!.status).toBe("APPROVED");
      expect(terminal!.verdicts).toHaveLength(1);
    });

    it("invalid reviewer output racing a cancellation cannot overwrite the cancellation", async () => {
      const { sessionId } = await succeededSession();
      const result = await reviewEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "invalid", delayMs: 40 } });
      const claim = await claimAndRunInBackground();
      await waitForStatus(result.reviewRequest.id, "RUNNING");
      await reviewEngine.cancelReview(result.reviewRequest.id, "tester");
      await claim!.done;
      const terminal = await reviewEngine.getReviewRequest(result.reviewRequest.id);
      expect(terminal!.status).toBe("CANCELLED");
    });

    it("a reviewer failure racing a cancellation cannot overwrite the cancellation", async () => {
      const { sessionId } = await succeededSession();
      const result = await reviewEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "failure", delayMs: 40 } });
      const claim = await claimAndRunInBackground();
      await waitForStatus(result.reviewRequest.id, "RUNNING");
      await reviewEngine.cancelReview(result.reviewRequest.id, "tester");
      await claim!.done;
      const terminal = await reviewEngine.getReviewRequest(result.reviewRequest.id);
      expect(terminal!.status).toBe("CANCELLED");
    });

    it("repeated cancellation of the same running review is idempotent and produces exactly one terminal outcome", async () => {
      const { sessionId } = await succeededSession();
      const result = await reviewEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "cancellation", delayMs: 5 } });
      const claim = await claimAndRunInBackground();
      await waitForStatus(result.reviewRequest.id, "RUNNING");
      const outcomes = await Promise.all([
        reviewEngine.cancelReview(result.reviewRequest.id, "tester"),
        reviewEngine.cancelReview(result.reviewRequest.id, "tester"),
        reviewEngine.cancelReview(result.reviewRequest.id, "tester")
      ]);
      // Every concurrent caller must observe either "cancellation is in flight" or "already cancelled" — never an error, and none may report a different terminal outcome.
      expect(outcomes.every(outcome => ["CANCELLATION_REQUESTED", "CANCELLED"].includes(outcome.reviewRequest?.status ?? ""))).toBe(true);
      await claim!.done;
      const terminal = await reviewEngine.getReviewRequest(result.reviewRequest.id);
      expect(terminal!.status).toBe("CANCELLED");
      expect(terminal!.verdicts).toHaveLength(0);
      // Exactly one CANCELLATION_REQUESTED event: the two idempotent replay calls must not each append a duplicate.
      expect(terminal!.events.filter(event => event.eventType === "REVIEW_CANCELLATION_REQUESTED")).toHaveLength(1);
    });

    it("simultaneous finalization attempts still create exactly one ReviewVerdict row", async () => {
      const { sessionId } = await succeededSession();
      const result = await reviewEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "approve" } });
      const claim = await reviewEngine.claimNext("owner-a");
      // Two concurrent finalize attempts against the same claimed review; the underlying CAS guarantees only one wins.
      await Promise.all([
        reviewEngine.runClaimed(claim!.reviewRequestId, claim!.leaseToken),
        reviewEngine.runClaimed(claim!.reviewRequestId, claim!.leaseToken).catch(() => undefined)
      ]);
      const terminal = await reviewEngine.getReviewRequest(result.reviewRequest.id);
      expect(terminal!.status).toBe("APPROVED");
      expect(terminal!.verdicts).toHaveLength(1);
    });
  });

  describe("durable claiming, ownership, and recovery", () => {
    it("claimNext is atomic: two engine instances sharing one database cannot both own the same review", async () => {
      const { sessionId } = await succeededSession();
      await reviewEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "approve" } });
      const otherEngine = new ReviewEngine(database.client, new FakeReviewer(), { allowFakeExecutorDiagnosticReviews: true, leaseMs: 2_000 });
      const [claimA, claimB] = await Promise.all([reviewEngine.claimNext("owner-a"), otherEngine.claimNext("owner-b")]);
      const claims = [claimA, claimB].filter((claim): claim is NonNullable<typeof claimA> => claim !== null);
      expect(claims).toHaveLength(1);
      await reviewEngine.runClaimed(claims[0]!.reviewRequestId, claims[0]!.leaseToken).catch(() => undefined);
      await otherEngine.runClaimed(claims[0]!.reviewRequestId, claims[0]!.leaseToken).catch(() => undefined);
    });

    it("heartbeat renews the lease for the current owner and fails for a stale token", async () => {
      const { sessionId } = await succeededSession();
      const result = await reviewEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "cancellation", delayMs: 5 } });
      const claim = await reviewEngine.claimNext("owner-heartbeat");
      expect(claim!.reviewRequestId).toBe(result.reviewRequest.id);
      expect(await reviewEngine.heartbeat(claim!.reviewRequestId, claim!.leaseToken)).toBe(true);
      expect(await reviewEngine.heartbeat(claim!.reviewRequestId, "not-the-real-token")).toBe(false);
      await reviewEngine.cancelReview(result.reviewRequest.id, "tester");
    });

    it("a claimed review with an expired lease and no cancellation request recovers to STALE, never inventing a verdict", async () => {
      const { sessionId } = await succeededSession();
      const shortLeaseEngine = new ReviewEngine(database.client, new FakeReviewer(), { allowFakeExecutorDiagnosticReviews: true, leaseMs: 5 });
      const result = await shortLeaseEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "approve" } });
      const claim = await shortLeaseEngine.claimNext("owner-abandoned");
      // Simulate an abandoned runtime host process (never transitions to RUNNING again, never heartbeats) by
      // forcing the lease into the past directly, instead of racing a real in-process reviewer call/timer.
      await database.client.reviewRequest.update({ where: { id: claim!.reviewRequestId }, data: { leaseExpiresAt: new Date(Date.now() - 1_000) } });
      const recovered = await shortLeaseEngine.recoverStaleReviews();
      expect(recovered).toBe(1);
      const terminal = await reviewEngine.getReviewRequest(result.reviewRequest.id);
      expect(terminal!.status).toBe("STALE");
      expect(terminal!.verdicts).toHaveLength(0);
      expect(terminal!.failureCode).toBe("STALE_LEASE");
    });

    it("a cancellation-requested review recovers to CANCELLED (not STALE) after owner loss", async () => {
      const { sessionId } = await succeededSession();
      const shortLeaseEngine = new ReviewEngine(database.client, new FakeReviewer(), { allowFakeExecutorDiagnosticReviews: true, leaseMs: 5 });
      const result = await shortLeaseEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "approve" } });
      const claim = await shortLeaseEngine.claimNext("owner-abandoned-2");
      await database.client.reviewRequest.update({ where: { id: claim!.reviewRequestId }, data: {
        status: "CANCELLATION_REQUESTED", cancellationRequestedAt: new Date(), leaseExpiresAt: new Date(Date.now() - 1_000)
      } });
      const recovered = await shortLeaseEngine.recoverStaleReviews();
      expect(recovered).toBe(1);
      const terminal = await reviewEngine.getReviewRequest(result.reviewRequest.id);
      expect(terminal!.status).toBe("CANCELLED");
    });

    it("a PENDING review survives a simulated restart (never claimed, still claimable)", async () => {
      const { sessionId } = await succeededSession();
      const result = await reviewEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "approve" } });
      // Simulate a restart: a brand-new engine instance, sharing only the database, must still be able to claim and run it.
      const restarted = new ReviewEngine(database.client, new FakeReviewer(), { allowFakeExecutorDiagnosticReviews: true });
      await claimAndAwait(restarted, "owner-restarted");
      const terminal = await restarted.getReviewRequest(result.reviewRequest.id);
      expect(terminal!.status).toBe("APPROVED");
    });

    it("a later PENDING review still runs after an earlier one hit an unexpected runtime error", async () => {
      const { sessionId: sessionA } = await succeededSession();
      const { sessionId: sessionB } = await succeededSession();
      const failing = await reviewEngine.requestReview(sessionA, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "failure" } });
      const healthy = await reviewEngine.requestReview(sessionB, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "approve" } });
      await claimAndAwait();
      await claimAndAwait();
      const failingTerminal = await reviewEngine.getReviewRequest(failing.reviewRequest.id);
      const healthyTerminal = await reviewEngine.getReviewRequest(healthy.reviewRequest.id);
      expect(failingTerminal!.status).toBe("ERROR");
      expect(healthyTerminal!.status).toBe("APPROVED");
    });

    it("a duplicate request against a claimed-but-recovered review does not strand forever", async () => {
      const { sessionId } = await succeededSession();
      const shortLeaseEngine = new ReviewEngine(database.client, new FakeReviewer(), { allowFakeExecutorDiagnosticReviews: true, leaseMs: 5 });
      const first = await shortLeaseEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "approve" } });
      const claim = await shortLeaseEngine.claimNext("owner-strand");
      await database.client.reviewRequest.update({ where: { id: claim!.reviewRequestId }, data: { leaseExpiresAt: new Date(Date.now() - 1_000) } });
      await shortLeaseEngine.recoverStaleReviews();
      const recovered = await reviewEngine.getReviewRequest(first.reviewRequest.id);
      expect(recovered!.status).toBe("STALE");
      const second = await reviewEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "approve" } });
      expect(second.duplicate).toBe(false);
      expect(second.reviewRequest.id).not.toBe(first.reviewRequest.id);
      await claimAndAwait();
      const terminal = await reviewEngine.getReviewRequest(second.reviewRequest.id);
      expect(terminal!.status).toBe("APPROVED");
    });

    it("recoverStaleReviews is a no-op when no lease has expired", async () => {
      const { sessionId } = await succeededSession();
      await reviewEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "cancellation", delayMs: 5 } });
      const claim = await reviewEngine.claimNext("owner-fresh");
      const recovered = await reviewEngine.recoverStaleReviews();
      expect(recovered).toBe(0);
      await reviewEngine.cancelReview(claim!.reviewRequestId, "tester");
    });
  });

  describe("lease-bound verdict finalization (finding 4)", () => {
    it("an expired lease prevents finalization even after the reviewer already produced output; recovery (never the finalize attempt) resolves it to STALE", async () => {
      const engine = new ReviewEngine(database.client, new FakeReviewer(), { allowFakeExecutorDiagnosticReviews: true, leaseMs: 10_000 });
      const { sessionId } = await succeededSession();
      const result = await engine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "approve", delayMs: 30 } });
      const claim = await claimAndRunInBackground(engine);
      await waitForStatus(result.reviewRequest.id, "RUNNING");
      await database.client.reviewRequest.update({ where: { id: claim!.reviewRequestId }, data: { leaseExpiresAt: new Date(Date.now() - 1_000) } });
      await claim!.done;
      const stillRunning = await engine.getReviewRequest(result.reviewRequest.id);
      expect(stillRunning!.status).toBe("RUNNING");
      expect(stillRunning!.verdicts).toHaveLength(0);
      const recovered = await engine.recoverStaleReviews();
      expect(recovered).toBe(1);
      const terminal = await engine.getReviewRequest(result.reviewRequest.id);
      expect(terminal!.status).toBe("STALE");
      expect(terminal!.verdicts).toHaveLength(0);
    });

    it("stale recovery winning the race prevents any subsequent verdict, even though the reviewer already produced output", async () => {
      const engine = new ReviewEngine(database.client, new FakeReviewer(), { allowFakeExecutorDiagnosticReviews: true, leaseMs: 10_000 });
      const { sessionId } = await succeededSession();
      const result = await engine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "approve", delayMs: 40 } });
      const claim = await claimAndRunInBackground(engine);
      await waitForStatus(result.reviewRequest.id, "RUNNING");
      await database.client.reviewRequest.update({ where: { id: claim!.reviewRequestId }, data: { leaseExpiresAt: new Date(Date.now() - 1_000) } });
      const recovered = await engine.recoverStaleReviews();
      expect(recovered).toBe(1);
      await claim!.done;
      const terminal = await engine.getReviewRequest(result.reviewRequest.id);
      expect(terminal!.status).toBe("STALE");
      expect(terminal!.verdicts).toHaveLength(0);
    });

    it("a new ownership generation (reclaim) prevents the old owner from finalizing and is never overwritten by it", async () => {
      const engine = new ReviewEngine(database.client, new FakeReviewer(), { allowFakeExecutorDiagnosticReviews: true, leaseMs: 10_000 });
      const { sessionId } = await succeededSession();
      const result = await engine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "approve", delayMs: 30 } });
      const claim = await claimAndRunInBackground(engine);
      await waitForStatus(result.reviewRequest.id, "RUNNING");
      // Simulate a fresh ownership generation (as recovery + a new claim would produce) appearing while the old owner's reviewer call is still in flight.
      await database.client.reviewRequest.update({ where: { id: claim!.reviewRequestId }, data: {
        ownerId: "intruder-owner", leaseToken: crypto.randomUUID(), claimAttempts: { increment: 1 }, leaseExpiresAt: new Date(Date.now() + 60_000)
      } });
      await claim!.done;
      const afterOldOwner = await engine.getReviewRequest(result.reviewRequest.id);
      expect(afterOldOwner!.status).toBe("RUNNING");
      expect(afterOldOwner!.verdicts).toHaveLength(0);
      expect(afterOldOwner!.ownerId).toBe("intruder-owner");
    });

    it.each([
      ["ownerId", { ownerId: "wrong-owner" }],
      ["leaseToken", { leaseToken: crypto.randomUUID() }],
      ["claimAttempts", { claimAttempts: { increment: 1 } }]
    ] as const)("a mismatched %s alone prevents finalization", async (_field, patch) => {
      const engine = new ReviewEngine(database.client, new FakeReviewer(), { allowFakeExecutorDiagnosticReviews: true, leaseMs: 10_000 });
      const { sessionId } = await succeededSession();
      const result = await engine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "approve", delayMs: 30 } });
      const claim = await claimAndRunInBackground(engine);
      await waitForStatus(result.reviewRequest.id, "RUNNING");
      await database.client.reviewRequest.update({ where: { id: claim!.reviewRequestId }, data: patch });
      await claim!.done;
      const row = await engine.getReviewRequest(result.reviewRequest.id);
      expect(row!.status).not.toBe("APPROVED");
      expect(row!.verdicts).toHaveLength(0);
    });

    it("clears ownership fields only on the transaction that actually wins finalization", async () => {
      const { sessionId } = await succeededSession();
      const result = await reviewEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "approve" } });
      await claimAndAwait();
      const terminal = await reviewEngine.getReviewRequest(result.reviewRequest.id);
      expect(terminal!.status).toBe("APPROVED");
      expect(terminal!.ownerId).toBeNull();
      expect(terminal!.leaseToken).toBeNull();
      expect(terminal!.leaseExpiresAt).toBeNull();
    });
  });

  describe("runtime host", () => {
    it("processes PENDING reviews end-to-end through a live ReviewRuntimeHost and stops cleanly", async () => {
      const { sessionId } = await succeededSession();
      const hostEngine = new ReviewEngine(database.client, new FakeReviewer(), { allowFakeExecutorDiagnosticReviews: true, leaseMs: 2_000 });
      const host = new ReviewRuntimeHost(hostEngine, { pollMs: 5 });
      host.start();
      try {
        const result = await hostEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "approve" } });
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const current = await hostEngine.getReviewRequest(result.reviewRequest.id);
          if (current && TERMINAL.includes(current.status)) break;
          await sleep(5);
        }
        const terminal = await hostEngine.getReviewRequest(result.reviewRequest.id);
        expect(terminal!.status).toBe("APPROVED");
      } finally {
        await host.stop();
      }
      expect(host.status().running).toBe(false);
    });

    it("two runtime hosts sharing a database claim disjoint reviews and never double-run one", async () => {
      const { sessionId: sessionA } = await succeededSession();
      const { sessionId: sessionB } = await succeededSession();
      const engineA = new ReviewEngine(database.client, new FakeReviewer(), { allowFakeExecutorDiagnosticReviews: true, leaseMs: 2_000 });
      const engineB = new ReviewEngine(database.client, new FakeReviewer(), { allowFakeExecutorDiagnosticReviews: true, leaseMs: 2_000 });
      const hostA = new ReviewRuntimeHost(engineA, { pollMs: 5 });
      const hostB = new ReviewRuntimeHost(engineB, { pollMs: 5 });
      hostA.start(); hostB.start();
      try {
        const resultA = await engineA.requestReview(sessionA, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "approve" } });
        const resultB = await engineB.requestReview(sessionB, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "reject" } });
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const [a, b] = await Promise.all([engineA.getReviewRequest(resultA.reviewRequest.id), engineA.getReviewRequest(resultB.reviewRequest.id)]);
          if (a && b && TERMINAL.includes(a.status) && TERMINAL.includes(b.status)) break;
          await sleep(5);
        }
        const terminalA = await engineA.getReviewRequest(resultA.reviewRequest.id);
        const terminalB = await engineA.getReviewRequest(resultB.reviewRequest.id);
        expect(terminalA!.status).toBe("APPROVED");
        expect(terminalA!.verdicts).toHaveLength(1);
        expect(terminalB!.status).toBe("REJECTED");
        expect(terminalB!.verdicts).toHaveLength(1);
      } finally {
        await hostA.stop();
        await hostB.stop();
      }
    });
  });

  describe("persistence invariants", () => {
    it("computes NOT_REQUESTED/NONE for an execution session with no review requests", async () => {
      const { sessionId } = await succeededSession();
      const projection = await reviewEngine.reviewGateProjection(sessionId);
      expect(projection).toEqual({
        state: "NOT_REQUESTED", authority: "NONE", reviewerId: null, reviewRequestId: null, verdictId: null, requestHash: null, commitAuthorityEligible: false
      });
    });

    it("projects the authority-preserving review gate without altering execution status", async () => {
      const { sessionId } = await succeededSession();
      const result = await reviewEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "reject" } });
      await claimAndAwait();
      const terminal = await reviewEngine.getReviewRequest(result.reviewRequest.id);
      const projection = await reviewEngine.reviewGateProjection(sessionId);
      expect(projection.state).toBe("REJECTED");
      expect(projection.authority).toBe("DIAGNOSTIC");
      expect(projection.reviewRequestId).toBe(result.reviewRequest.id);
      expect(projection.verdictId).toBe(terminal!.verdicts[0]!.id);
      expect(projection.requestHash).toBe(terminal!.requestHash);
      expect(projection.commitAuthorityEligible).toBe(false);
      const session = await database.client.executionSession.findUniqueOrThrow({ where: { id: sessionId } });
      expect(session.status).toBe("SUCCEEDED");
      const task = await database.client.task.findUniqueOrThrow({ where: { id: session.taskId } });
      expect(task.status).toBe("AWAITING_USER_ACCEPTANCE");
    });

    it("projects RUNNING for CLAIMED and CANCELLATION_REQUESTED alike", async () => {
      const { sessionId } = await succeededSession();
      const result = await reviewEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "cancellation", delayMs: 5 } });
      const claim = await claimAndRunInBackground();
      await waitForStatus(result.reviewRequest.id, "RUNNING");
      expect((await reviewEngine.reviewGateProjection(sessionId)).state).toBe("RUNNING");
      await reviewEngine.cancelReview(result.reviewRequest.id, "tester");
      expect((await reviewEngine.reviewGateProjection(sessionId)).state).toBe("RUNNING");
      await claim!.done;
    });

    it("a DIAGNOSTIC APPROVE can never satisfy the authoritative commit gate", async () => {
      const { sessionId } = await succeededSession();
      await reviewEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "approve" } });
      await claimAndAwait();
      const projection = await reviewEngine.reviewGateProjection(sessionId);
      expect(projection.state).toBe("APPROVED");
      expect(projection.authority).toBe("DIAGNOSTIC");
      expect(canSatisfyAuthoritativeReviewGate(projection)).toBe(false);
      expect(canSatisfyAuthoritativeReviewGate({ ...projection, commitAuthorityEligible: true, authority: "AUTHORITATIVE" })).toBe(false);
    });

    it("STALE, CANCELLED, and ERROR reviews can never satisfy the authoritative commit gate", async () => {
      const staleSession = await succeededSession();
      const staleResult = await reviewEngine.requestReview(staleSession.sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "approve", delayMs: 30 } });
      const staleClaim = await claimAndRunInBackground();
      await database.client.executionSession.update({ where: { id: staleSession.sessionId }, data: { finalEvidenceJson: JSON.stringify({ evidence: { branch: "main", head: "mutated" } }) } });
      await staleClaim!.done;
      expect(canSatisfyAuthoritativeReviewGate(await reviewEngine.reviewGateProjection(staleSession.sessionId))).toBe(false);
      void staleResult;

      const errorSession = await succeededSession();
      await reviewEngine.requestReview(errorSession.sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "failure" } });
      await claimAndAwait();
      expect(canSatisfyAuthoritativeReviewGate(await reviewEngine.reviewGateProjection(errorSession.sessionId))).toBe(false);

      const cancelledSession = await succeededSession();
      const cancelledResult = await reviewEngine.requestReview(cancelledSession.sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "approve" } });
      await reviewEngine.cancelReview(cancelledResult.reviewRequest.id, "tester");
      expect((await reviewEngine.reviewGateProjection(cancelledSession.sessionId)).state).toBe("NOT_REQUESTED");
    });

    it("refuses to mutate a terminal ReviewRequest row directly", async () => {
      const { sessionId } = await succeededSession();
      const result = await reviewEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "approve" } });
      await claimAndAwait();
      await expect(database.client.reviewRequest.update({ where: { id: result.reviewRequest.id }, data: { status: "PENDING" } })).rejects.toThrow();
    });

    it("refuses to update or delete an append-only ReviewVerdict row", async () => {
      const { sessionId } = await succeededSession();
      const result = await reviewEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "approve" } });
      await claimAndAwait();
      const terminal = await reviewEngine.getReviewRequest(result.reviewRequest.id);
      const verdictId = terminal!.verdicts[0]!.id;
      await expect(database.client.reviewVerdict.update({ where: { id: verdictId }, data: { summary: "tampered" } })).rejects.toThrow();
      await expect(database.client.reviewVerdict.delete({ where: { id: verdictId } })).rejects.toThrow();
    });

    it("keeps ReviewEvent sequence numbers monotonic per review request", async () => {
      const { sessionId } = await succeededSession();
      const result = await reviewEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "approve" } });
      await claimAndAwait();
      const terminal = await reviewEngine.getReviewRequest(result.reviewRequest.id);
      const sequences = terminal!.events.map(event => event.sequence);
      expect(sequences).toEqual([...sequences].sort((left, right) => left - right));
      expect(new Set(sequences).size).toBe(sequences.length);
    });

    it("prevents two active reviews for the same execution via the unique index", async () => {
      const { sessionId, taskId } = await succeededSession();
      await reviewEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "approve", delayMs: 30 } });
      const approval = await database.client.approval.findFirstOrThrow({ where: { taskId, status: "APPROVED" } });
      await expect(database.client.reviewRequest.create({ data: {
        id: crypto.randomUUID(), executionSessionId: sessionId, projectId, taskId,
        reviewerId: "fake-reviewer", reviewAuthority: "DIAGNOSTIC", approvalId: approval.id, approvalStatus: "APPROVED",
        approvalReviewerSelection: "CLAUDE", taskSelectedReviewer: "CLAUDE", executionExecutorId: "fake",
        status: "PENDING", taskSpecHash: "a".repeat(64), approvalSnapshotHash: "a".repeat(64), executionCapsuleHash: "a".repeat(64),
        baselineGitEvidenceHash: "a".repeat(64), finalGitEvidenceHash: "a".repeat(64), verificationResultsHash: "a".repeat(64), executionArtifactSetHash: "a".repeat(64),
        executionResultStatus: "succeeded", finalBranch: "main", finalHead: "abc", reviewPolicyVersion: "2.3A-v1",
        reviewInputJson: "{}", reviewInputHash: "b".repeat(64), requestHash: "b".repeat(64),
        reviewerConfigHash: "b".repeat(64), requestedBy: "tester"
      } })).rejects.toThrow();
      await claimAndAwait();
    });
  });

  describe("database-enforced single verdict (finding 3)", () => {
    it("rejects a second ReviewVerdict row for the same ReviewRequest at the database level", async () => {
      const { sessionId } = await succeededSession();
      const result = await reviewEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "approve" } });
      await claimAndAwait();
      const terminal = await reviewEngine.getReviewRequest(result.reviewRequest.id);
      expect(terminal!.verdicts).toHaveLength(1);
      await expect(database.client.reviewVerdict.create({ data: {
        id: crypto.randomUUID(), reviewRequestId: result.reviewRequest.id, verdict: "APPROVE", summary: "second verdict",
        findingsJson: "[]", requiredActionsJson: "[]", confidence: 1, reviewerVersion: "fake-reviewer@1", reviewedRequestHash: terminal!.requestHash
      } })).rejects.toThrow();
    });

    it("allows two different ReviewRequests to each have their own verdict", async () => {
      const { sessionId: sessionA } = await succeededSession();
      const { sessionId: sessionB } = await succeededSession();
      const resultA = await reviewEngine.requestReview(sessionA, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "approve" } });
      const resultB = await reviewEngine.requestReview(sessionB, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "reject" } });
      await claimAndAwait();
      await claimAndAwait();
      const terminalA = await reviewEngine.getReviewRequest(resultA.reviewRequest.id);
      const terminalB = await reviewEngine.getReviewRequest(resultB.reviewRequest.id);
      expect(terminalA!.verdicts).toHaveLength(1);
      expect(terminalB!.verdicts).toHaveLength(1);
      expect(terminalA!.verdicts[0]!.id).not.toBe(terminalB!.verdicts[0]!.id);
    });

    // The request below is deliberately left PENDING (zero verdicts, not
    // claimed/finalized first) so the two concurrent inserts genuinely race
    // for the first verdict slot — a prior version of this test finalized
    // the request before racing, so both concurrent attempts were really
    // racing against an already-existing verdict, not against each other.
    it.each([1, 2, 3])("attempt %i: two concurrent direct inserts against a zero-verdict request produce exactly one winner", async () => {
      const { sessionId } = await succeededSession();
      const result = await reviewEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "approve" } });
      const requestHash = result.reviewRequest.requestHash;
      expect(result.reviewRequest.verdicts).toHaveLength(0);

      const attempts = await Promise.allSettled([
        database.client.reviewVerdict.create({ data: {
          id: crypto.randomUUID(), reviewRequestId: result.reviewRequest.id, verdict: "APPROVE", summary: "race A",
          findingsJson: "[]", requiredActionsJson: "[]", confidence: 1, reviewerVersion: "fake-reviewer@1", reviewedRequestHash: requestHash
        } }),
        database.client.reviewVerdict.create({ data: {
          id: crypto.randomUUID(), reviewRequestId: result.reviewRequest.id, verdict: "REJECT", summary: "race B",
          findingsJson: canonicalJson([{ id: "f1", severity: "BLOCKER", category: "diagnostic", title: "t", description: "d", evidenceReferences: [], blocking: true }]),
          requiredActionsJson: "[]", confidence: 1, reviewerVersion: "fake-reviewer@1", reviewedRequestHash: requestHash
        } })
      ]);

      expect(attempts.filter(attempt => attempt.status === "fulfilled")).toHaveLength(1);
      expect(attempts.filter(attempt => attempt.status === "rejected")).toHaveLength(1);
      const rejected = attempts.find(attempt => attempt.status === "rejected");
      expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(Error);

      const verdicts = await database.client.reviewVerdict.findMany({ where: { reviewRequestId: result.reviewRequest.id } });
      expect(verdicts).toHaveLength(1);

      await reviewEngine.cancelReview(result.reviewRequest.id, "tester");
    });

    it("confirms different ReviewRequests may each receive their own verdict without contending for the same unique slot", async () => {
      const { sessionId: sessionA } = await succeededSession();
      const { sessionId: sessionB } = await succeededSession();
      const resultA = await reviewEngine.requestReview(sessionA, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "approve" } });
      const resultB = await reviewEngine.requestReview(sessionB, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "approve" } });
      await claimAndAwait();
      await claimAndAwait();
      const [verdictsA, verdictsB] = await Promise.all([
        database.client.reviewVerdict.findMany({ where: { reviewRequestId: resultA.reviewRequest.id } }),
        database.client.reviewVerdict.findMany({ where: { reviewRequestId: resultB.reviewRequest.id } })
      ]);
      expect(verdictsA).toHaveLength(1);
      expect(verdictsB).toHaveLength(1);
      expect(verdictsA[0]!.id).not.toBe(verdictsB[0]!.id);
    });

    it("refuses to update or delete a ReviewVerdict row directly (append-only, independent of the unique constraint)", async () => {
      const { sessionId } = await succeededSession();
      const result = await reviewEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "approve" } });
      await claimAndAwait();
      const terminal = await reviewEngine.getReviewRequest(result.reviewRequest.id);
      const verdictId = terminal!.verdicts[0]!.id;
      await expect(database.client.reviewVerdict.update({ where: { id: verdictId }, data: { reviewRequestId: crypto.randomUUID() } })).rejects.toThrow();
      await expect(database.client.reviewVerdict.delete({ where: { id: verdictId } })).rejects.toThrow();
    });
  });

  describe("database-enforced active-payload immutability", () => {
    const PROTECTED_UPDATES: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ["reviewInputJson", { reviewInputJson: "{}" }],
      ["reviewInputHash", { reviewInputHash: "c".repeat(64) }],
      ["reviewerConfigJson", { reviewerConfigJson: "{}" }],
      ["reviewerConfigHash", { reviewerConfigHash: "c".repeat(64) }],
      ["requestHash", { requestHash: "c".repeat(64) }],
      ["reviewAuthority", { reviewAuthority: "AUTHORITATIVE" }],
      ["executionCapsuleHash", { executionCapsuleHash: "c".repeat(64) }],
      ["baselineGitEvidenceHash", { baselineGitEvidenceHash: "c".repeat(64) }]
    ];

    async function expectProtectedFieldsRejected(id: string): Promise<void> {
      for (const [, data] of PROTECTED_UPDATES) {
        await expect(database.client.reviewRequest.update({ where: { id }, data })).rejects.toThrow();
      }
    }

    it("rejects protected-field updates while PENDING, but still allows a legitimate lifecycle update", async () => {
      const { sessionId } = await succeededSession();
      const result = await reviewEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "approve" } });
      const id = result.reviewRequest.id;
      await expectProtectedFieldsRejected(id);
      await expect(database.client.reviewRequest.update({ where: { id }, data: { heartbeatAt: new Date() } })).resolves.toBeTruthy();
      await reviewEngine.cancelReview(id, "tester");
    });

    it("rejects protected-field updates while CLAIMED, but still allows a legitimate lifecycle update", async () => {
      const { sessionId } = await succeededSession();
      const result = await reviewEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "cancellation", delayMs: 5 } });
      const id = result.reviewRequest.id;
      await reviewEngine.claimNext("owner-immutable-claimed");
      await expectProtectedFieldsRejected(id);
      await expect(database.client.reviewRequest.update({ where: { id }, data: { heartbeatAt: new Date() } })).resolves.toBeTruthy();
      await reviewEngine.cancelReview(id, "tester");
    });

    it("rejects protected-field updates while RUNNING, but still allows a legitimate lifecycle update", async () => {
      const { sessionId } = await succeededSession();
      const result = await reviewEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "cancellation", delayMs: 5 } });
      const id = result.reviewRequest.id;
      const claim = await claimAndRunInBackground();
      await waitForStatus(id, "RUNNING");
      await expectProtectedFieldsRejected(id);
      await expect(database.client.reviewRequest.update({ where: { id }, data: { heartbeatAt: new Date() } })).resolves.toBeTruthy();
      await reviewEngine.cancelReview(id, "tester");
      await claim!.done;
    });

    it("rejects protected-field updates while CANCELLATION_REQUESTED, but still allows a legitimate lifecycle update", async () => {
      const { sessionId } = await succeededSession();
      const result = await reviewEngine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "approve" } });
      const id = result.reviewRequest.id;
      await reviewEngine.claimNext("owner-immutable-cancelreq");
      // Drive the lifecycle columns directly (no live reviewer involved) so the
      // row deterministically sits in CANCELLATION_REQUESTED — racing a real
      // background reviewer/cancellation here would non-deterministically let
      // it resolve to a terminal status before the assertions below run.
      await database.client.reviewRequest.update({ where: { id }, data: { status: "RUNNING", startedAt: new Date() } });
      await database.client.reviewRequest.update({ where: { id }, data: { status: "CANCELLATION_REQUESTED", cancellationRequestedAt: new Date() } });
      await expectProtectedFieldsRejected(id);
      await expect(database.client.reviewRequest.update({ where: { id }, data: { heartbeatAt: new Date() } })).resolves.toBeTruthy();
      await database.client.reviewRequest.update({ where: { id }, data: {
        status: "CANCELLED", finishedAt: new Date(), ownerId: null, leaseToken: null, claimedAt: null, heartbeatAt: null, leaseExpiresAt: null
      } });
    });
  });

  describe("runtime self-validation of the immutable input binding", () => {
    async function expectCorruptFixtureBecomesStale(corrupt: (fixture: ReturnType<typeof buildSelfConsistentReviewRequestFixture>) => Record<string, unknown>): Promise<void> {
      const { sessionId, taskId } = await succeededSession();
      const session = await database.client.executionSession.findUniqueOrThrow({ where: { id: sessionId }, select: { projectId: true } });
      const reviewRequestId = crypto.randomUUID();
      const fixture = buildSelfConsistentReviewRequestFixture({ reviewRequestId, executionSessionId: sessionId, projectId: session.projectId, taskId });
      await database.client.reviewRequest.create({ data: { ...fixture.data, ...corrupt(fixture) } });

      const capturing = new CapturingReviewer();
      const engine = new ReviewEngine(database.client, capturing, { allowFakeExecutorDiagnosticReviews: true });
      const claim = await engine.claimNext("owner-corrupt-fixture");
      expect(claim!.reviewRequestId).toBe(reviewRequestId);
      await engine.runClaimed(claim!.reviewRequestId, claim!.leaseToken);

      const terminal = await engine.getReviewRequest(reviewRequestId);
      expect(terminal!.status).toBe("STALE");
      expect(terminal!.failureCode).toBe("REVIEW_IMMUTABLE_INPUT_MISMATCH");
      expect(terminal!.verdicts).toHaveLength(0);
      expect(terminal!.ownerId).toBeNull();
      expect(terminal!.leaseToken).toBeNull();
      expect(terminal!.leaseExpiresAt).toBeNull();
      // The reviewer must never be invoked once corruption is detected before it starts.
      expect(capturing.lastCapsule).toBeUndefined();
      const staleEvents = terminal!.events.filter(event => event.eventType === "REVIEW_STALE_INVALIDATED");
      expect(staleEvents.length).toBeGreaterThan(0);
      const audit = await database.client.auditEvent.findMany({ where: { executionSessionId: sessionId, action: "REVIEW_STALE_INVALIDATED" } });
      expect(audit.length).toBeGreaterThan(0);
    }

    it("a reviewInputJson/reviewInputHash mismatch becomes STALE without ever invoking the reviewer", async () => {
      await expectCorruptFixtureBecomesStale(() => ({ reviewInputHash: "f".repeat(64) }));
    });

    it("a reviewerConfigJson/reviewerConfigHash mismatch becomes STALE without ever invoking the reviewer", async () => {
      await expectCorruptFixtureBecomesStale(() => ({ reviewerConfigHash: "f".repeat(64) }));
    });

    it("malformed reviewerConfigJson (fails the reviewer's own schema) becomes STALE", async () => {
      const malformed = canonicalJson({ outcome: "approve", unexpectedField: true });
      return expectCorruptFixtureBecomesStale(() => ({ reviewerConfigJson: malformed, reviewerConfigHash: sha256Hex(malformed) }));
    });

    it("a requestHash inconsistent with reviewInputHash/reviewerConfigHash becomes STALE", async () => {
      await expectCorruptFixtureBecomesStale(() => ({ requestHash: "f".repeat(64) }));
    });

    it("a self-consistent (untampered) fixture passes the immutable-binding check specifically, distinguishing it from a corrupted one", async () => {
      const { sessionId, taskId } = await succeededSession();
      const session = await database.client.executionSession.findUniqueOrThrow({ where: { id: sessionId }, select: { projectId: true } });
      const reviewRequestId = crypto.randomUUID();
      const fixture = buildSelfConsistentReviewRequestFixture({ reviewRequestId, executionSessionId: sessionId, projectId: session.projectId, taskId });
      await database.client.reviewRequest.create({ data: fixture.data });
      const claim = await reviewEngine.claimNext("owner-consistent-fixture");
      expect(claim!.reviewRequestId).toBe(reviewRequestId);
      await reviewEngine.runClaimed(claim!.reviewRequestId, claim!.leaseToken);
      const terminal = await reviewEngine.getReviewRequest(reviewRequestId);
      // The fixture's evidence fields are synthetic and don't correspond to
      // this session's real approval, so it correctly still goes STALE — but
      // for live-evidence reasons (EVIDENCE_CHANGED), never
      // REVIEW_IMMUTABLE_INPUT_MISMATCH. This proves the corruption tests
      // above are exercising the binding check specifically, not merely
      // asserting "any STALE outcome" regardless of cause.
      expect(terminal!.status).toBe("STALE");
      expect(terminal!.failureCode).toBe("EVIDENCE_CHANGED");
    });
  });
});
