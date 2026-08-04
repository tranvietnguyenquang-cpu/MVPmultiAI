import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalJson, EVIDENCE_ARTIFACT_SCHEMA_VERSION, LOG_PROVENANCE_SCHEMA_VERSION, LOG_RECORD_SCHEMA_VERSION, MATERIAL_BUDGET_POLICY_VERSION, parseHandoffText, untruncatedProvenance, type ClaudeReviewerConfig, type LogProvenance, type NormalizedTaskSpec, type ReviewerDescriptor, type StructuredReviewVerdict } from "@project-relay/relay-v2-domain";
import { createDisposableRelayV2Database } from "@project-relay/relay-v2-persistence/testing";
import { RelayV2Orchestrator } from "@project-relay/relay-v2-orchestrator";
import { ExecutionArtifactStore, ExecutionEngine, FakeExecutor } from "@project-relay/relay-v2-execution";
import { FakeReviewer } from "./fake-reviewer.js";
import { ReviewAuthorityError, ReviewEngine } from "./review-engine.js";
import type { ImmutableReviewCapsule, PreparedReviewMaterial, PreparedReviewerInvocation, RelayReviewer, ReviewControls, ReviewerHealth, ReviewerValidationRequest, ReviewerValidationResult } from "./reviewer-contract.js";
import { changedFilesArtifact, emptyStreamCapture, finalGitArtifact, lostStreamCapture } from "./evidence-test-fixtures.js";
import { buildReviewMaterialSections } from "./review-material-sections.js";
import { computeReviewInputHash, reviewInputCapsuleSchema, sha256Hex } from "./review-binding.js";

function sleep(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(5);
  }
  throw new Error("Condition was not met before the timeout.");
}

/** Hangs inside review() until its AbortSignal fires, then rejects -- lets a test deterministically simulate "the process is still running" and assert that heartbeat/ownership loss actually aborts it. */
class HangingUntilAbortedReviewer implements RelayReviewer {
  readonly id: string;
  aborted = false;
  constructor(id: string) { this.id = id; }
  describe(): ReviewerDescriptor { return { id: this.id, displayName: "Hanging test double", providerType: "FAKE", readOnly: true, structuredOutput: true, cancellationSupport: true, capabilities: [] }; }
  async validate(request: ReviewerValidationRequest): Promise<ReviewerValidationResult> { void request; return { valid: true }; }
  async review(_capsule: ImmutableReviewCapsule, controls: ReviewControls): Promise<StructuredReviewVerdict> {
    await new Promise<never>((_resolve, reject) => {
      const fail = () => { this.aborted = true; reject(controls.signal.reason ?? new Error("aborted")); };
      if (controls.signal.aborted) { fail(); return; }
      controls.signal.addEventListener("abort", fail, { once: true });
    });
    throw new Error("unreachable");
  }
  async health(): Promise<ReviewerHealth> { return { healthy: true, checkedAt: new Date().toISOString(), message: "ok" }; }
}

/** Tracks whether review() was ever called, without hanging -- for tests that must prove a Claude process never spawns (blocked before invocation). */
/**
 * The prompt/stdin preparation every AUTHORITATIVE-capable reviewer must
 * provide: deterministic, built once, and measured from the exact strings it
 * builds. ReviewEngine runs it again at finalization and requires identical
 * results, so a test double that skipped it would be exercising a path
 * production can never take -- an authoritative review with no bound prompt is
 * refused before any invocation row is created.
 */
const TEST_POLICY_PROMPT = "TEST REVIEW POLICY";
function testPrepareInvocation(capsule: ImmutableReviewCapsule, material: PreparedReviewMaterial): PreparedReviewerInvocation {
  const finalPrompt = `${TEST_POLICY_PROMPT}\n${material.materialCanonicalJson}`;
  const finalStdin = `${finalPrompt}\nrequestHash: ${capsule.requestHash}\n`;
  const bytes = (text: string) => Buffer.byteLength(text, "utf8");
  return {
    promptPolicyVersion: "test-prompt-policy-v1",
    policyPrompt: TEST_POLICY_PROMPT,
    policyPromptByteCount: bytes(TEST_POLICY_PROMPT),
    finalPrompt, finalPromptByteCount: bytes(finalPrompt),
    finalStdin, finalStdinByteCount: bytes(finalStdin),
    promptHash: sha256Hex(finalPrompt),
    finalStdinHash: sha256Hex(finalStdin),
    promptAccounting: {
      materialJsonBytes: material.materialByteCount,
      manifestJsonBytes: bytes(canonicalJson(material.envelope.core.evidenceManifest)),
      budgetLedgerJsonBytes: bytes(material.ledgerJson),
      policyPromptBytes: bytes(TEST_POLICY_PROMPT),
      finalPromptBytes: bytes(finalPrompt),
      finalStdinBytes: bytes(finalStdin)
    }
  };
}

class TrackingClaudeReviewer implements RelayReviewer {
  readonly id = "claude-cli";
  called = false;
  materialPolicyPrompt(): string { return TEST_POLICY_PROMPT; }
  prepareInvocation(capsule: ImmutableReviewCapsule, material: PreparedReviewMaterial): PreparedReviewerInvocation { return testPrepareInvocation(capsule, material); }
  describe(): ReviewerDescriptor { return { id: this.id, displayName: "Tracking test double", providerType: "FAKE", readOnly: true, structuredOutput: true, cancellationSupport: true, capabilities: [] }; }
  async validate(request: ReviewerValidationRequest): Promise<ReviewerValidationResult> { void request; return { valid: true }; }
  async review(): Promise<StructuredReviewVerdict> { this.called = true; throw new Error("TrackingClaudeReviewer.review() should never be called in this test."); }
  async health(): Promise<ReviewerHealth> { return { healthy: true, checkedAt: new Date().toISOString(), message: "ok" }; }
}

/** Approves once, and counts its calls, so a test can prove Claude was never rerun after a finalization mismatch. */
class ApprovingClaudeReviewer implements RelayReviewer {
  readonly id = "claude-cli";
  calls = 0;
  materialPolicyPrompt(): string { return TEST_POLICY_PROMPT; }
  prepareInvocation(capsule: ImmutableReviewCapsule, material: PreparedReviewMaterial): PreparedReviewerInvocation { return testPrepareInvocation(capsule, material); }
  /** How many times review() ran for each review request id -- a rerun after finalization would show as 2. */
  readonly callsByRequest = new Map<string, number>();
  describe(): ReviewerDescriptor { return { id: this.id, displayName: "Approving test double", providerType: "FAKE", readOnly: true, structuredOutput: true, cancellationSupport: true, capabilities: [] }; }
  async validate(request: ReviewerValidationRequest): Promise<ReviewerValidationResult> { void request; return { valid: true }; }
  async review(capsule: ImmutableReviewCapsule, controls?: ReviewControls): Promise<StructuredReviewVerdict> {
    void controls;
    this.calls += 1;
    this.callsByRequest.set(capsule.reviewRequestId, (this.callsByRequest.get(capsule.reviewRequestId) ?? 0) + 1);
    return { reviewedRequestHash: capsule.requestHash, verdict: "APPROVE", summary: "ok", findings: [], requiredActions: [], confidence: 1, reviewerVersion: "test-1" };
  }
  async health(): Promise<ReviewerHealth> { return { healthy: true, checkedAt: new Date().toISOString(), message: "ok" }; }
}

const claudeConfigFixture: ClaudeReviewerConfig = {
  reviewerId: "claude-cli", model: "AUTO", reasoningOrEffort: "AUTO", timeoutSeconds: 60,
  outputSchemaVersion: "claude-verdict-v1", materializerVersion: "claude-materializer-v1", promptPolicyVersion: "claude-prompt-policy-v1",
  wrapperContractId: "claude-json-schema-result-v1", wrapperParserVersion: "1",
  capabilitySnapshotId: "11111111-1111-1111-1111-111111111111", capabilitySnapshotHash: "c".repeat(64),
  executableIdentityHash: "a".repeat(64), cliVersion: "2.1.220",
  readOnlyPolicy: "DENY_ALL_TOOLS", toolPolicy: "TOOLS_EMPTY_STRING",
  configurationIsolationPolicy: "SAFE_MODE_STRICT_MCP_NO_SESSION_NO_SLASH_COMMANDS", artifactSelectionPolicy: "BOUND_CAPSULE_ONLY",
  maximumInputBytes: 500_000, maximumOutputBytes: 2_000_000, materialBudgetVersion: "material-budget-v1"
};

const handoff = {
  version: 1,
  project: { name: "Invocation Lifecycle Test" },
  task: { title: "Exercise invocation lifecycle", objective: "Prove heartbeat/quarantine behavior", taskType: "implementation", complexity: "normal" },
  constraints: [],
  acceptanceCriteria: ["Invocation lifecycle behaves safely"],
  execution: { executor: "fake", model: "auto", effort: "medium", reviewer: "claude", requireApproval: true, allowSourceTransmissionToApi: false }
};

describe("ReviewInvocation lifecycle", () => {
  let database: Awaited<ReturnType<typeof createDisposableRelayV2Database>>;
  let orchestrator: RelayV2Orchestrator;
  let executionEngine: ExecutionEngine;
  let artifactStore: ExecutionArtifactStore;
  let workspace: string;
  let projectId: string;
  let counter = 0;

  beforeAll(async () => {
    database = await createDisposableRelayV2Database();
    orchestrator = new RelayV2Orchestrator(database.client);
    workspace = await mkdtemp(path.join(tmpdir(), "relay-v2-invocation-workspace-"));
    await mkdir(path.join(workspace, ".git"));
    projectId = (await orchestrator.createProject({ name: "Invocation Lifecycle Test", localPath: workspace })).id;
    artifactStore = new ExecutionArtifactStore(database.paths.artifactsDir, 1_024);
    executionEngine = new ExecutionEngine(database.client, new FakeExecutor(), artifactStore, { timeoutMs: 5_000, leaseMs: 5_000 });
  }, 30_000);

  afterAll(async () => {
    await database.cleanup();
    await rm(workspace, { recursive: true, force: true });
  });

  function spec(): NormalizedTaskSpec { return parseHandoffText(JSON.stringify(handoff)).normalized; }

  async function succeededSession(): Promise<{ sessionId: string; taskId: string }> {
    counter += 1;
    const created = await orchestrator.createPendingTask({ projectId, normalized: spec(), source: "MANUAL", idempotencyKey: `invocation-${counter}` });
    await orchestrator.approveTask(created.task.id, "test-approver");
    const request = await executionEngine.requestExecution(created.task.id, "test", { outcome: "success", eventCount: 1, delayMs: 0 });
    const claim = await executionEngine.claimNext();
    await executionEngine.runClaimed(claim!.sessionId, claim!.leaseToken);
    return { sessionId: request.session.id, taskId: created.task.id };
  }

  /** Mirrors buildExecutionCapsule's self-referential hash shape closely enough for capsule-integrity checks. */
  function selfConsistentCapsule(sessionId: string): { capsuleHash: string; capsuleJson: string } {
    const withoutHash = { sessionId };
    const capsuleHash = createHash("sha256").update(canonicalJson(withoutHash), "utf8").digest("hex");
    return { capsuleHash, capsuleJson: canonicalJson({ ...withoutHash, capsuleHash }) };
  }

  function sha256Hex(value: string): string {
    return createHash("sha256").update(value, "utf8").digest("hex");
  }

  /** Self-consistent, strictly-valid persisted `VerificationResult` (own resultHash), matching verification-catalog.ts's shape. */
  function selfConsistentVerificationResult(overrides: Record<string, unknown> = {}) {
    const withoutHash = {
      operation: "NPM_TEST", displayCommand: "npm test", passed: true, exitCode: 0, timedOut: false, cancelled: false,
      summary: "npm test passed.",
      stdoutPreview: "", stdoutTruncated: false, stdoutProvenance: untruncatedProvenance(""),
      stderrPreview: "", stderrTruncated: false, stderrProvenance: untruncatedProvenance(""),
      runnerOutputTruncated: false, runnerStdoutBytes: 0, runnerStderrBytes: 0,
      stdoutCapture: emptyStreamCapture("stdout"), stderrCapture: emptyStreamCapture("stderr"),
      startedAt: "2026-08-03T00:00:00.000Z", finishedAt: "2026-08-03T00:00:01.000Z",
      ...overrides
    };
    return { ...withoutHash, resultHash: sha256Hex(canonicalJson(withoutHash)) };
  }

  /** Strictly-valid, self-consistent persisted baseline `GitEvidence` JSON, matching the strict evidence schema in review-binding.ts. */
  function validBaselineGitEvidenceJson(): string {
    const withoutHash = {
      repositoryRoot: "C:/fixture-repo", branch: "main", head: "a".repeat(40), dirty: false,
      status: [], stagedCount: 0, unstagedCount: 0, untrackedCount: 0,
      patchPreview: "", patchSha256: sha256Hex(""), patchTruncated: false, patchProvenance: untruncatedProvenance(""), patchOmittedForSensitivePaths: false
    };
    return canonicalJson({ ...withoutHash, capturedAt: "2026-08-03T00:00:00.000Z", evidenceHash: sha256Hex(canonicalJson(withoutHash)) });
  }

  /** Strictly-valid, self-consistent persisted final `{ evidence, delta }` envelope JSON. */
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

  /**
   * Promotes a diagnostic FakeExecutor session to look like a codex-cli
   * session with a CLAUDE-reviewed approval, so resolveReviewerAuthority
   * grants AUTHORITATIVE mode to a reviewer registered as "claude-cli". A
   * genuine codex-cli run always writes a real FINAL_GIT artifact file
   * (see ExecutionEngine.runClaimed); a FakeExecutor session never does, so
   * this writes one for real -- through the same ExecutionArtifactStore the
   * tests' ReviewEngine is configured with -- to satisfy the AUTHORITATIVE
   * artifact-store requirement (Milestone 2.3B fourth corrective pass). LOG
   * is already written for real by every succeededSession() run.
   */
  async function promoteToAuthoritativeEligible(sessionId: string): Promise<void> {
    const capsule = selfConsistentCapsule(sessionId);
    const finalEvidenceJson = validFinalGitEvidenceJson();
    const envelope = JSON.parse(finalEvidenceJson) as { evidence: { branch: string; head: string; evidenceHash: string; status: unknown[] } };
    await database.client.executionSession.update({ where: { id: sessionId }, data: {
      executorId: "codex-cli", ...capsule,
      baselineEvidenceJson: validBaselineGitEvidenceJson(), finalEvidenceJson
    } });
    // The artifact bytes and the database projection must reduce to the same
    // canonical semantics, so both are derived from this one envelope.
    const finalGit = finalGitArtifact([], {
      branch: envelope.evidence.branch, head: envelope.evidence.head,
      clean: envelope.evidence.status.length === 0, captureEvidenceHash: envelope.evidence.evidenceHash
    });
    await writeEvidenceArtifact(sessionId, "FINAL_GIT", "final-git.json", canonicalJson(finalGit));
    await writeEvidenceArtifact(sessionId, "CHANGED_FILES", "changed-files.json", canonicalJson(changedFilesArtifact([])));
  }

  /** Writes one versioned evidence artifact through the real store and records its row with truthful provenance. */
  async function writeEvidenceArtifact(sessionId: string, artifactType: "FINAL_GIT" | "CHANGED_FILES" | "PATCH" | "VERIFICATION", filename: string, body: string): Promise<void> {
    const metadata = await artifactStore.writeArtifact(sessionId, artifactType, filename, body, { schemaVersion: EVIDENCE_ARTIFACT_SCHEMA_VERSION });
    await database.client.executionArtifact.upsert({
      where: { sessionId_artifactType_relativePath: { sessionId, artifactType: metadata.artifactType, relativePath: metadata.relativePath } },
      create: { id: randomUUID(), sessionId, ...metadata },
      update: {
        sha256: metadata.sha256, byteCount: metadata.byteCount, truncated: metadata.truncated,
        schemaVersion: metadata.schemaVersion, fullContentSha256: metadata.fullContentSha256,
        originalByteCount: metadata.originalByteCount, omittedByteCount: metadata.omittedByteCount,
        truncationMethod: metadata.truncationMethod
      }
    });
  }

  /**
   * Rewrites BOTH stores to a different-but-equally-valid evidence state, in
   * lockstep: the artifact bytes, the artifact row's own hashes, and the
   * database projection, each internally consistent afterwards. Nothing except
   * a full rebuild of the request's identity can detect this.
   */
  async function replaceCoherentEvidence(sessionId: string, branch: string): Promise<void> {
    const session = await database.client.executionSession.findUniqueOrThrow({ where: { id: sessionId } });
    const current = JSON.parse(session.finalEvidenceJson) as { evidence: Record<string, unknown>; delta: Record<string, unknown> };
    const withoutHash = current.evidence as Record<string, unknown> & { capturedAt: string };
    const capturedAt = withoutHash.capturedAt;
    const rest = Object.fromEntries(Object.entries(withoutHash).filter(([key]) => key !== "evidenceHash" && key !== "capturedAt"));
    const replaced = { ...rest, branch };
    const evidence = { ...replaced, capturedAt, evidenceHash: sha256Hex(canonicalJson(replaced)) };
    await database.client.executionSession.update({
      where: { id: sessionId },
      data: { finalEvidenceJson: canonicalJson({ evidence, delta: { ...current.delta, finalHash: evidence.evidenceHash } }) }
    });
    const fields = evidence as unknown as { head: string; status: unknown[] };
    await writeEvidenceArtifact(sessionId, "FINAL_GIT", "final-git.json", canonicalJson(finalGitArtifact([], {
      branch, head: fields.head, clean: fields.status.length === 0, captureEvidenceHash: evidence.evidenceHash
    })));
  }

  /**
   * Deterministically fabricates "a claimed review is stuck mid-invocation" --
   * claims a real PENDING review, transitions it to RUNNING, and appends a
   * PREPARING invocation row, all without ever calling runClaimed/reviewer.review().
   * This is a faithful stand-in for a runtime crash (the real process is simply
   * gone, never resolving anything) without needing a live hung promise and its
   * background timers, which are awkward to clean up deterministically in a test.
   */
  async function fabricateStuckInvocation(engine: ReviewEngine, reviewRequestId: string, reviewerId: string, ownerId: string): Promise<void> {
    const claim = await engine.claimNext(ownerId);
    expect(claim?.reviewRequestId).toBe(reviewRequestId);
    await database.client.reviewRequest.update({
      where: { id: reviewRequestId },
      data: { status: "RUNNING", startedAt: new Date(), leaseExpiresAt: new Date(Date.now() - 1_000) }
    });
    await database.client.reviewInvocation.create({ data: { id: randomUUID(), reviewRequestId, reviewerId, status: "PREPARING", ownerId, claimAttempt: claim!.claimAttempt } });
  }

  it("aborts an in-flight reviewer process when heartbeat fails (ownership lost mid-invocation), and records OWNERSHIP_LOST", async () => {
    const hanging = new HangingUntilAbortedReviewer("fake-reviewer");
    const engine = new ReviewEngine(database.client, hanging, { allowFakeExecutorDiagnosticReviews: true, leaseMs: 300 });
    const { sessionId } = await succeededSession();
    await engine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true });
    const claim = await engine.claimNext("owner-a");
    expect(claim).not.toBeNull();
    const runPromise = engine.runClaimed(claim!.reviewRequestId, claim!.leaseToken);

    // Wait until the PREPARING invocation row exists -- proof the reviewer is actually "in flight".
    await waitUntil(async () => (await database.client.reviewInvocation.count({ where: { reviewRequestId: claim!.reviewRequestId } })) > 0);

    // Simulate another owner reclaiming this review's lease out from under the running invocation.
    await database.client.reviewRequest.update({ where: { id: claim!.reviewRequestId }, data: { leaseToken: randomUUID() } });

    await runPromise;
    expect(hanging.aborted).toBe(true);

    const invocations = await database.client.reviewInvocation.findMany({ where: { reviewRequestId: claim!.reviewRequestId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
    expect(invocations[0]?.status).toBe("OWNERSHIP_LOST");
  }, 15_000);

  it("marks a runtime-restart-recovered invocation INTERRUPTED_UNCERTAIN, never a terminal outcome implying a proven result", async () => {
    const engine = new ReviewEngine(database.client, new FakeReviewer(), { allowFakeExecutorDiagnosticReviews: true });
    const { sessionId } = await succeededSession();
    const requested = await engine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true });
    await fabricateStuckInvocation(engine, requested.reviewRequest.id, "fake-reviewer", "owner-b");

    const recovered = await engine.recoverStaleReviews("simulated-restart");
    expect(recovered).toBeGreaterThanOrEqual(1);

    const invocations = await database.client.reviewInvocation.findMany({ where: { reviewRequestId: requested.reviewRequest.id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
    expect(invocations[0]?.status).toBe("INTERRUPTED_UNCERTAIN");
    const request = await engine.getReviewRequest(requested.reviewRequest.id);
    expect(request?.status).toBe("STALE");
  });

  it("quarantines a new AUTHORITATIVE-capable review request while a prior invocation for the same execution session is unresolved", async () => {
    const engine = new ReviewEngine(database.client, new HangingUntilAbortedReviewer("claude-cli"), { allowFakeExecutorDiagnosticReviews: true, artifactsRoot: database.paths.artifactsDir });
    const { sessionId } = await succeededSession();
    await promoteToAuthoritativeEligible(sessionId);

    const first = await engine.requestReview(sessionId, projectId, "claude-cli", "tester", { reviewerConfig: claudeConfigFixture });
    expect(first.reviewRequest.reviewAuthority).toBe("AUTHORITATIVE");
    await fabricateStuckInvocation(engine, first.reviewRequest.id, "claude-cli", "owner-c");
    await engine.recoverStaleReviews("simulated-restart-2");

    // A brand-new review request for the SAME execution session must now be refused,
    // even though the prior ReviewRequest itself is already terminal (STALE) --
    // the quarantine is keyed on the *invocation's* unresolved status, not the request's.
    await expect(engine.requestReview(sessionId, projectId, "claude-cli", "tester", { reviewerConfig: claudeConfigFixture })).rejects.toThrow(/quarantined/i);
  });

  it("never quarantines fake-reviewer diagnostic requests, even while a real reviewer's invocation is unresolved", async () => {
    const engine = new ReviewEngine(database.client, [new HangingUntilAbortedReviewer("claude-cli"), new FakeReviewer()], { allowFakeExecutorDiagnosticReviews: true, allowCodexTestDoubleDiagnosticReviews: true, artifactsRoot: database.paths.artifactsDir });
    const { sessionId } = await succeededSession();
    await promoteToAuthoritativeEligible(sessionId);

    const first = await engine.requestReview(sessionId, projectId, "claude-cli", "tester", { reviewerConfig: claudeConfigFixture });
    await fabricateStuckInvocation(engine, first.reviewRequest.id, "claude-cli", "owner-d");
    await engine.recoverStaleReviews("simulated-restart-3");

    // fake-reviewer never spawns a process, so it is exempt from the quarantine
    // even though claude-cli's invocation for this same session is still unresolved.
    const diagnostic = await engine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "approve" } });
    expect(diagnostic.reviewRequest.reviewAuthority).toBe("DIAGNOSTIC");
    // Left PENDING deliberately (this test only asserts on requestReview's
    // authorization decision) -- cancel it so it cannot be picked up by a
    // later test's claimNext() call against this same shared database.
    await engine.cancelReview(diagnostic.reviewRequest.id);
  });

  it("does not quarantine an unrelated execution session's review request", async () => {
    const engine = new ReviewEngine(database.client, new HangingUntilAbortedReviewer("claude-cli"), { allowFakeExecutorDiagnosticReviews: true, artifactsRoot: database.paths.artifactsDir });
    const { sessionId: quarantinedSession } = await succeededSession();
    await promoteToAuthoritativeEligible(quarantinedSession);
    const quarantined = await engine.requestReview(quarantinedSession, projectId, "claude-cli", "tester", { reviewerConfig: claudeConfigFixture });
    await fabricateStuckInvocation(engine, quarantined.reviewRequest.id, "claude-cli", "owner-e");
    await engine.recoverStaleReviews("simulated-restart-4");

    const { sessionId: otherSession } = await succeededSession();
    await promoteToAuthoritativeEligible(otherSession);
    const otherRequest = await engine.requestReview(otherSession, projectId, "claude-cli", "tester", { reviewerConfig: claudeConfigFixture });
    expect(otherRequest.reviewRequest.reviewAuthority).toBe("AUTHORITATIVE");
    // Left PENDING deliberately -- cancel it so it cannot be picked up by a
    // later test's claimNext() call against this same shared database.
    await engine.cancelReview(otherRequest.reviewRequest.id);
  });

  it("finalizes the single ReviewInvocation row to a terminal status even for a reviewer that never calls recordInvocation (FakeReviewer), never a second row", async () => {
    const engine = new ReviewEngine(database.client, new FakeReviewer(), { allowFakeExecutorDiagnosticReviews: true, leaseMs: 5_000 });
    const { sessionId } = await succeededSession();
    const requested = await engine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "approve" } });
    const claim = await engine.claimNext("owner-f");
    await engine.runClaimed(claim!.reviewRequestId, claim!.leaseToken);
    const invocations = await database.client.reviewInvocation.findMany({ where: { reviewRequestId: requested.reviewRequest.id } });
    // Exactly one row -- the schema's UNIQUE(reviewRequestId) constraint
    // enforces this at the database level too; this is the CAS-updated same
    // row transitioning PREPARING -> SUCCEEDED in place, never a second row.
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.status).toBe("SUCCEEDED");
    expect(invocations[0]?.ownerId).toBe("owner-f");
  });

  it("the database rejects a second ReviewInvocation row for the same review request", async () => {
    const engine = new ReviewEngine(database.client, new FakeReviewer(), { allowFakeExecutorDiagnosticReviews: true });
    const { sessionId } = await succeededSession();
    const requested = await engine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true });
    const claim = await engine.claimNext("owner-g");
    expect(claim?.reviewRequestId).toBe(requested.reviewRequest.id);
    await database.client.reviewRequest.update({ where: { id: requested.reviewRequest.id }, data: { status: "RUNNING", startedAt: new Date() } });
    await database.client.reviewInvocation.create({ data: { id: randomUUID(), reviewRequestId: requested.reviewRequest.id, reviewerId: "fake-reviewer", status: "PREPARING", ownerId: "owner-g", claimAttempt: claim!.claimAttempt } });
    await expect(database.client.reviewInvocation.create({
      data: { id: randomUUID(), reviewRequestId: requested.reviewRequest.id, reviewerId: "fake-reviewer", status: "PREPARING", ownerId: "owner-g", claimAttempt: claim!.claimAttempt }
    })).rejects.toThrow();
  });

  it("never calls reviewer.review() when atomic invocation creation fails (an invocation already exists for this request)", async () => {
    let reviewCalled = false;
    class TrackingReviewer extends FakeReviewer {
      override async review(capsule: ImmutableReviewCapsule, controls: ReviewControls): Promise<StructuredReviewVerdict> {
        reviewCalled = true;
        return super.review(capsule, controls);
      }
    }
    const engine = new ReviewEngine(database.client, new TrackingReviewer(), { allowFakeExecutorDiagnosticReviews: true });
    const { sessionId } = await succeededSession();
    const requested = await engine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true, reviewerConfig: { outcome: "approve" } });
    const claim = await engine.claimNext("owner-h");
    // Simulate a pre-existing invocation row winning the race before
    // runClaimed's own atomic createOwnedInvocationOrThrow ever runs -- the
    // schema's UNIQUE(reviewRequestId) means this is the same failure mode
    // a genuine concurrent double-invocation attempt would hit. Created while
    // the request is still CLAIMED (runClaimed itself performs the
    // CLAIMED -> RUNNING transition below), using the exact ownership
    // generation claimNext already assigned.
    await database.client.reviewInvocation.create({ data: { id: randomUUID(), reviewRequestId: requested.reviewRequest.id, reviewerId: "fake-reviewer", status: "PREPARING", ownerId: "owner-h", claimAttempt: claim!.claimAttempt } });

    await engine.runClaimed(claim!.reviewRequestId, claim!.leaseToken);

    expect(reviewCalled).toBe(false);
    const request = await engine.getReviewRequest(requested.reviewRequest.id);
    expect(request?.status).toBe("ERROR");
    const invocations = await database.client.reviewInvocation.findMany({ where: { reviewRequestId: requested.reviewRequest.id } });
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.status).toBe("PREPARING");
  });

  it("rejects requestReview for a nonexistent authority before ever creating an invocation (no invocation row leaks from a rejected request)", async () => {
    const engine = new ReviewEngine(database.client, new FakeReviewer(), { allowFakeExecutorDiagnosticReviews: false });
    const { sessionId } = await succeededSession();
    await expect(engine.requestReview(sessionId, projectId, "fake-reviewer", "tester", { diagnostic: true })).rejects.toBeInstanceOf(ReviewAuthorityError);
    const requests = await database.client.reviewRequest.findMany({ where: { executionSessionId: sessionId }, select: { id: true } });
    const invocations = await database.client.reviewInvocation.findMany({ where: { reviewRequestId: { in: requests.map(request => request.id) } } });
    expect(invocations).toHaveLength(0);
  });

  // ==========================================================================
  // Milestone 2.3B fourth corrective pass -- artifact-store requirement,
  // material byte budget, and immutable validated-byte flow, exercised
  // end-to-end through the real ReviewEngine + database + on-disk artifact
  // store (not just the pure review-binding.ts functions).
  // ==========================================================================

  it("rejects an AUTHORITATIVE request when this engine has no artifact store configured, before any ReviewRequest row is created", async () => {
    const reviewer = new TrackingClaudeReviewer();
    // Deliberately no artifactsRoot option.
    const engine = new ReviewEngine(database.client, reviewer, { allowFakeExecutorDiagnosticReviews: true });
    const { sessionId } = await succeededSession();
    await promoteToAuthoritativeEligible(sessionId);

    await expect(engine.requestReview(sessionId, projectId, "claude-cli", "tester", { reviewerConfig: claudeConfigFixture })).rejects.toThrow(/artifact/i);

    const requests = await database.client.reviewRequest.findMany({ where: { executionSessionId: sessionId } });
    expect(requests).toHaveLength(0);
    expect(reviewer.called).toBe(false);
  });

  it("errors (never STALE) a claimed AUTHORITATIVE review whose artifact store becomes unreadable between claim and run, with no ReviewInvocation and no reviewer.review() call", async () => {
    const reviewer = new TrackingClaudeReviewer();
    const engine = new ReviewEngine(database.client, reviewer, { allowFakeExecutorDiagnosticReviews: true, artifactsRoot: database.paths.artifactsDir });
    const { sessionId } = await succeededSession();
    await promoteToAuthoritativeEligible(sessionId);

    const requested = await engine.requestReview(sessionId, projectId, "claude-cli", "tester", { reviewerConfig: claudeConfigFixture });
    expect(requested.reviewRequest.reviewAuthority).toBe("AUTHORITATIVE");

    // Corrupt the on-disk FINAL_GIT artifact after the request was accepted but before it is claimed and run.
    const artifactRow = await database.client.executionArtifact.findFirstOrThrow({ where: { sessionId, artifactType: "FINAL_GIT" } });
    await writeFile(path.join(database.paths.artifactsDir, artifactRow.relativePath), "corrupted-content-not-matching-recorded-hash");

    const claim = await engine.claimNext("owner-corrupt-store");
    expect(claim).not.toBeNull();
    await engine.runClaimed(claim!.reviewRequestId, claim!.leaseToken);

    expect(reviewer.called).toBe(false);
    const request = await engine.getReviewRequest(requested.reviewRequest.id);
    expect(request?.status).toBe("ERROR");
    const invocations = await database.client.reviewInvocation.findMany({ where: { reviewRequestId: requested.reviewRequest.id } });
    expect(invocations).toHaveLength(0);
  });

  it("rejects an AUTHORITATIVE request whose verification evidence exceeds the material budget, before any ReviewRequest row is created (no Claude process spawns)", async () => {
    const reviewer = new TrackingClaudeReviewer();
    const engine = new ReviewEngine(database.client, reviewer, { allowFakeExecutorDiagnosticReviews: true, artifactsRoot: database.paths.artifactsDir });
    const { sessionId } = await succeededSession();
    await promoteToAuthoritativeEligible(sessionId);

    // Ten verification results, each with a stdout preview at the capsule
    // schema's own per-entry bound (20,000 bytes) -- 200,000 bytes total,
    // exceeding the coordinated VERIFICATION_STDOUT material budget
    // (163,840 bytes) even though every individual field is schema-valid.
    const bigStdout = "x".repeat(20_000);
    const results = Array.from({ length: 10 }, () => selfConsistentVerificationResult({ stdoutPreview: bigStdout }));
    await database.client.executionSession.update({ where: { id: sessionId }, data: { verificationResultsJson: canonicalJson(results) } });

    await expect(engine.requestReview(sessionId, projectId, "claude-cli", "tester", { reviewerConfig: claudeConfigFixture })).rejects.toThrow(/VERIFICATION_STDOUT|budget/i);

    const requests = await database.client.reviewRequest.findMany({ where: { executionSessionId: sessionId } });
    expect(requests).toHaveLength(0);
    expect(reviewer.called).toBe(false);
  });

  it("detects a LOG artifact mutated after it was bound into the reviewer's material, and never persists a verdict from stale bytes", async () => {
    const { sessionId } = await succeededSession();
    await promoteToAuthoritativeEligible(sessionId);
    const logArtifactRow = await database.client.executionArtifact.findFirstOrThrow({ where: { sessionId, artifactType: "LOG" } });
    const logPath = path.join(database.paths.artifactsDir, logArtifactRow.relativePath);
    const originalLogBytes = await readFile(logPath, "utf8");

    let observedLogPreview: string | undefined;
    class MutatingReviewer implements RelayReviewer {
      readonly id = "claude-cli";
      materialPolicyPrompt(): string { return TEST_POLICY_PROMPT; }
      prepareInvocation(capsule: ImmutableReviewCapsule, material: PreparedReviewMaterial): PreparedReviewerInvocation { return testPrepareInvocation(capsule, material); }
      describe(): ReviewerDescriptor { return { id: this.id, displayName: "Mutating test double", providerType: "FAKE", readOnly: true, structuredOutput: true, cancellationSupport: true, capabilities: [] }; }
      async validate(request: ReviewerValidationRequest): Promise<ReviewerValidationResult> { void request; return { valid: true }; }
      async review(capsule: ImmutableReviewCapsule): Promise<StructuredReviewVerdict> {
        observedLogPreview = capsule.executionLogEvidence.preview;
        // Simulate external tampering with the artifact store while the reviewer's process is "running".
        await writeFile(logPath, "TAMPERED-AFTER-VALIDATION");
        return { reviewedRequestHash: capsule.requestHash, verdict: "APPROVE", summary: "ok", findings: [], requiredActions: [], confidence: 1, reviewerVersion: "test-1" };
      }
      async health(): Promise<ReviewerHealth> { return { healthy: true, checkedAt: new Date().toISOString(), message: "ok" }; }
    }

    const engine = new ReviewEngine(database.client, new MutatingReviewer(), { allowFakeExecutorDiagnosticReviews: true, artifactsRoot: database.paths.artifactsDir });
    const requested = await engine.requestReview(sessionId, projectId, "claude-cli", "tester", { reviewerConfig: claudeConfigFixture });
    expect(requested.reviewRequest.reviewAuthority).toBe("AUTHORITATIVE");

    const claim = await engine.claimNext("owner-mutate-log");
    expect(claim).not.toBeNull();
    await engine.runClaimed(claim!.reviewRequestId, claim!.leaseToken);

    // The reviewer received exactly the bytes bound at request/pre-spawn time -- never re-read mid-flight.
    expect(observedLogPreview).toBe(originalLogBytes);

    const request = await engine.getReviewRequest(requested.reviewRequest.id);
    expect(["ERROR", "STALE"]).toContain(request?.status);
    const verdicts = await database.client.reviewVerdict.findMany({ where: { reviewRequestId: requested.reviewRequest.id } });
    expect(verdicts).toHaveLength(0);
  });

  describe("cross-store divergence and finalization reconstruction", () => {
    /** Replaces the persisted Git evidence with different-but-internally-valid content whose self-hash is recomputed correctly. */
    async function replaceDatabaseGitEvidence(sessionId: string, branch: string): Promise<void> {
      const session = await database.client.executionSession.findUniqueOrThrow({ where: { id: sessionId } });
      const current = JSON.parse(session.finalEvidenceJson) as { evidence: Record<string, unknown>; delta: Record<string, unknown> };
      const { capturedAt, ...withHash } = current.evidence as Record<string, unknown> & { capturedAt: string };
      const rest = Object.fromEntries(Object.entries(withHash).filter(([key]) => key !== "evidenceHash"));
      const replaced = { ...rest, branch };
      const evidence = { ...replaced, capturedAt, evidenceHash: sha256Hex(canonicalJson(replaced)) };
      await database.client.executionSession.update({
        where: { id: sessionId },
        data: { finalEvidenceJson: canonicalJson({ evidence, delta: { ...current.delta, finalHash: evidence.evidenceHash } }) }
      });
    }

    it("rejects the request when the database Git evidence diverges from the artifact bytes, with no ReviewRequest, no reviewer call, and no verdict", async () => {
      const reviewer = new TrackingClaudeReviewer();
      const engine = new ReviewEngine(database.client, reviewer, { allowFakeExecutorDiagnosticReviews: true, artifactsRoot: database.paths.artifactsDir });
      const { sessionId } = await succeededSession();
      await promoteToAuthoritativeEligible(sessionId);

      // The artifact bytes are untouched; only the database JSON is rewritten,
      // and its own self-hash is recomputed correctly -- so nothing except the
      // cross-store comparison can catch it.
      await replaceDatabaseGitEvidence(sessionId, "attacker-branch");

      await expect(engine.requestReview(sessionId, projectId, "claude-cli", "tester", { reviewerConfig: claudeConfigFixture }))
        .rejects.toThrow(/artifact store and the database have diverged/);
      expect(await database.client.reviewRequest.findMany({ where: { executionSessionId: sessionId } })).toHaveLength(0);
      expect(await database.client.reviewVerdict.count({ where: { reviewRequest: { executionSessionId: sessionId } } })).toBe(0);
      expect(reviewer.called).toBe(false);
    });

    it("rejects the request when the artifact bytes diverge from the database, even with row metadata rebuilt around the new bytes", async () => {
      const reviewer = new TrackingClaudeReviewer();
      const engine = new ReviewEngine(database.client, reviewer, { allowFakeExecutorDiagnosticReviews: true, artifactsRoot: database.paths.artifactsDir });
      const { sessionId } = await succeededSession();
      await promoteToAuthoritativeEligible(sessionId);

      const row = await database.client.executionArtifact.findFirstOrThrow({ where: { sessionId, artifactType: "FINAL_GIT" } });
      const forged = canonicalJson(finalGitArtifact([], { branch: "attacker-branch" }));
      await writeFile(path.join(database.paths.artifactsDir, row.relativePath), forged, "utf8");
      const forgedHash = createHash("sha256").update(forged).digest("hex");
      await database.client.executionArtifact.update({
        where: { id: row.id },
        data: {
          sha256: forgedHash, byteCount: Buffer.byteLength(forged, "utf8"),
          fullContentSha256: forgedHash, originalByteCount: Buffer.byteLength(forged, "utf8")
        }
      });

      await expect(engine.requestReview(sessionId, projectId, "claude-cli", "tester", { reviewerConfig: claudeConfigFixture }))
        .rejects.toThrow(/artifact store and the database have diverged/);
      expect(await database.client.reviewRequest.findMany({ where: { executionSessionId: sessionId } })).toHaveLength(0);
      expect(reviewer.called).toBe(false);
    });

    it("blocks a session whose changed-file artifact is missing entirely, before any reviewer runs", async () => {
      const reviewer = new TrackingClaudeReviewer();
      const engine = new ReviewEngine(database.client, reviewer, { allowFakeExecutorDiagnosticReviews: true, artifactsRoot: database.paths.artifactsDir });
      const { sessionId } = await succeededSession();
      await promoteToAuthoritativeEligible(sessionId);
      await database.client.executionArtifact.deleteMany({ where: { sessionId, artifactType: "CHANGED_FILES" } });

      await expect(engine.requestReview(sessionId, projectId, "claude-cli", "tester", { reviewerConfig: claudeConfigFixture }))
        .rejects.toThrow(/changed-file artifact is required/);
      expect(reviewer.called).toBe(false);
    });

    it("blocks a session whose critical evidence the writer could not persist in full", async () => {
      const reviewer = new TrackingClaudeReviewer();
      const engine = new ReviewEngine(database.client, reviewer, { allowFakeExecutorDiagnosticReviews: true, artifactsRoot: database.paths.artifactsDir });
      const { sessionId } = await succeededSession();
      await promoteToAuthoritativeEligible(sessionId);
      await database.client.executionArtifact.updateMany({
        where: { sessionId, artifactType: "FINAL_GIT" },
        data: { truncated: true, omittedByteCount: 128, truncationMethod: "HEAD" }
      });

      await expect(engine.requestReview(sessionId, projectId, "claude-cli", "tester", { reviewerConfig: claudeConfigFixture }))
        .rejects.toThrow(/incomplete FINAL_GIT evidence/);
      expect(reviewer.called).toBe(false);
    });

    it("binds the material byte ledger into the request and reconstructs it before accepting a verdict", async () => {
      const engine = new ReviewEngine(database.client, new ApprovingClaudeReviewer(), { allowFakeExecutorDiagnosticReviews: true, artifactsRoot: database.paths.artifactsDir });
      const { sessionId } = await succeededSession();
      await promoteToAuthoritativeEligible(sessionId);
      const requested = await engine.requestReview(sessionId, projectId, "claude-cli", "tester", { reviewerConfig: claudeConfigFixture });

      const row = await database.client.reviewRequest.findUniqueOrThrow({ where: { id: requested.reviewRequest.id } });
      expect(row.materialBudgetPolicyVersion).toBe(MATERIAL_BUDGET_POLICY_VERSION);
      expect(row.materialBudgetLedgerHash).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.parse(row.materialBudgetLedgerJson)).toMatchObject({ policyVersion: MATERIAL_BUDGET_POLICY_VERSION });

      const claim = await engine.claimNext("owner-ledger-ok");
      await engine.runClaimed(claim!.reviewRequestId, claim!.leaseToken);
      const finalized = await engine.getReviewRequest(requested.reviewRequest.id);
      expect([finalized?.status, finalized?.failureCode, finalized?.failureMessage]).toEqual(["APPROVED", null, null]);
    });

    it("refuses at the database level to rewrite a request's bound ledger identity", async () => {
      const engine = new ReviewEngine(database.client, new ApprovingClaudeReviewer(), { allowFakeExecutorDiagnosticReviews: true, artifactsRoot: database.paths.artifactsDir });
      const { sessionId } = await succeededSession();
      await promoteToAuthoritativeEligible(sessionId);
      const requested = await engine.requestReview(sessionId, projectId, "claude-cli", "tester", { reviewerConfig: claudeConfigFixture });

      await expect(database.client.$executeRawUnsafe(
        'UPDATE "ReviewRequest" SET "materialBudgetLedgerHash" = ? WHERE "id" = ?',
        "0".repeat(64), requested.reviewRequest.id
      )).rejects.toThrow(/immutable payload/);
    });

    it("invalidates the review as STALE, with no verdict, when the ledger no longer reconstructs to what the request was bound to", async () => {
      // The ledger is a function of the capsule AND the reviewer's own policy
      // prompt. Changing the prompt between request and finalization changes
      // what reconstruction computes without touching any hash-bound evidence
      // field -- so this isolates the ledger check from the requestHash check.
      class ShiftingPolicyReviewer extends ApprovingClaudeReviewer {
        policy = "policy-at-request-time";
        materialPolicyPrompt(): string { return this.policy; }
      }
      const reviewer = new ShiftingPolicyReviewer();
      const engine = new ReviewEngine(database.client, reviewer, { allowFakeExecutorDiagnosticReviews: true, artifactsRoot: database.paths.artifactsDir });
      const { sessionId } = await succeededSession();
      await promoteToAuthoritativeEligible(sessionId);
      const requested = await engine.requestReview(sessionId, projectId, "claude-cli", "tester", { reviewerConfig: claudeConfigFixture });
      const boundLedgerHash = (await database.client.reviewRequest.findUniqueOrThrow({ where: { id: requested.reviewRequest.id } })).materialBudgetLedgerHash;

      reviewer.policy = "a materially different reviewer policy prompt";

      // Other cases in this suite leave PENDING rows behind, and claimNext
      // takes the oldest, so drain until this request is the one claimed.
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const claim = await engine.claimNext("owner-ledger-drift");
        expect(claim).not.toBeNull();
        await engine.runClaimed(claim!.reviewRequestId, claim!.leaseToken);
        if (claim!.reviewRequestId === requested.reviewRequest.id) break;
      }

      const finalized = await engine.getReviewRequest(requested.reviewRequest.id);
      expect(finalized?.status).toBe("STALE");
      expect(await database.client.reviewVerdict.findMany({ where: { reviewRequestId: requested.reviewRequest.id } })).toHaveLength(0);
      // The bound ledger identity itself is untouched.
      expect((await database.client.reviewRequest.findUniqueOrThrow({ where: { id: requested.reviewRequest.id } })).materialBudgetLedgerHash).toBe(boundLedgerHash);
      // The mismatch is caught by the PRE-SPAWN reconstruction, so the
      // reviewer is never called even once -- Claude is not knowingly run
      // against a binding whose verdict would have to be thrown away
      // afterwards. No invocation row exists either, and nothing is rerun.
      expect(reviewer.callsByRequest.get(requested.reviewRequest.id)).toBeUndefined();
      expect(await database.client.reviewInvocation.findMany({ where: { reviewRequestId: requested.reviewRequest.id } })).toHaveLength(0);
    });
  });

  describe("pre-spawn reconstruction and engine-owned finalization", () => {
    /** Claims this specific request, draining any older PENDING rows other cases left behind. */
    async function claimSpecific(engine: ReviewEngine, reviewRequestId: string, ownerId: string): Promise<{ reviewRequestId: string; leaseToken: string }> {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const claim = await engine.claimNext(ownerId);
        expect(claim).not.toBeNull();
        if (claim!.reviewRequestId === reviewRequestId) return claim!;
        await engine.runClaimed(claim!.reviewRequestId, claim!.leaseToken);
      }
      throw new Error("The target review request was never claimed.");
    }

    it("blocks an AUTHORITATIVE request whose verification output was lost at the process-runner boundary, even though the operation passed", async () => {
      const reviewer = new TrackingClaudeReviewer();
      const engine = new ReviewEngine(database.client, reviewer, { allowFakeExecutorDiagnosticReviews: true, artifactsRoot: database.paths.artifactsDir });
      const { sessionId } = await succeededSession();
      await promoteToAuthoritativeEligible(sessionId);

      // PASSED, exit code 0, and no captured output -- because the runner
      // discarded 4,096 bytes of it before this runtime ever saw them.
      const lost = selfConsistentVerificationResult({
        runnerOutputTruncated: true, runnerStdoutBytes: 4_096,
        stdoutCapture: lostStreamCapture("stdout", 4_096),
        stdoutProvenance: { producerTruncated: false, captureTruncated: true, originalByteCount: 0, includedByteCount: 0, omittedByteCount: 0, truncationMethod: "NONE", fullContentSha256: sha256Hex("") }
      });
      await database.client.executionSession.update({ where: { id: sessionId }, data: { verificationResultsJson: canonicalJson([lost]) } });

      await expect(engine.requestReview(sessionId, projectId, "claude-cli", "tester", { reviewerConfig: claudeConfigFixture }))
        .rejects.toThrow(/cannot proceed on output that cannot be proven complete/);
      expect(await database.client.reviewRequest.findMany({ where: { executionSessionId: sessionId } })).toHaveLength(0);
      expect(reviewer.called).toBe(false);
    });

    it("detects evidence that changed COHERENTLY after the claim, with no invocation, no reviewer call, and no verdict", async () => {
      const reviewer = new ApprovingClaudeReviewer();
      const engine = new ReviewEngine(database.client, reviewer, { allowFakeExecutorDiagnosticReviews: true, artifactsRoot: database.paths.artifactsDir });
      const { sessionId } = await succeededSession();
      await promoteToAuthoritativeEligible(sessionId);
      const requested = await engine.requestReview(sessionId, projectId, "claude-cli", "tester", { reviewerConfig: claudeConfigFixture });
      const claim = await claimSpecific(engine, requested.reviewRequest.id, "owner-coherent-drift");

      // Evidence A becomes evidence B in BOTH stores at once, each internally
      // valid with its own self-hashes correctly recomputed. Every
      // cross-store, schema, and self-hash check still passes; the only thing
      // that can catch it is rebuilding the whole binding and finding that it
      // no longer reproduces this request's identity.
      await replaceCoherentEvidence(sessionId, "coherently-drifted-branch");

      await engine.runClaimed(claim.reviewRequestId, claim.leaseToken);

      const finalized = await engine.getReviewRequest(requested.reviewRequest.id);
      expect(finalized?.status).toBe("STALE");
      expect(finalized?.failureCode).toBe("EVIDENCE_CHANGED");
      expect(reviewer.callsByRequest.get(requested.reviewRequest.id)).toBeUndefined();
      expect(await database.client.reviewInvocation.findMany({ where: { reviewRequestId: requested.reviewRequest.id } })).toHaveLength(0);
      expect(await database.client.reviewVerdict.findMany({ where: { reviewRequestId: requested.reviewRequest.id } })).toHaveLength(0);
    });

    it("persists the complete transmitted identity on the PREPARING row BEFORE the reviewer is ever called", async () => {
      let identityAtReviewTime: Record<string, unknown> | null = null;
      class IdentityObservingReviewer extends ApprovingClaudeReviewer {
        override async review(capsule: ImmutableReviewCapsule, controls: ReviewControls): Promise<StructuredReviewVerdict> {
          const row = await database.client.reviewInvocation.findUnique({ where: { reviewRequestId: capsule.reviewRequestId } });
          identityAtReviewTime = row as unknown as Record<string, unknown>;
          expect(controls.prepared).toBeDefined();
          return super.review(capsule, controls);
        }
      }
      const reviewer = new IdentityObservingReviewer();
      const engine = new ReviewEngine(database.client, reviewer, { allowFakeExecutorDiagnosticReviews: true, artifactsRoot: database.paths.artifactsDir });
      const { sessionId } = await succeededSession();
      await promoteToAuthoritativeEligible(sessionId);
      const requested = await engine.requestReview(sessionId, projectId, "claude-cli", "tester", { reviewerConfig: claudeConfigFixture });
      const claim = await claimSpecific(engine, requested.reviewRequest.id, "owner-preparing-identity");
      await engine.runClaimed(claim.reviewRequestId, claim.leaseToken);

      expect((await engine.getReviewRequest(requested.reviewRequest.id))?.status).toBe("APPROVED");
      // Every identity was already durable when the reviewer ran -- not
      // written afterwards from whatever the process reported it had used.
      expect(identityAtReviewTime).toMatchObject({
        status: "PREPARING",
        materialEnvelopeVersion: "review-material-envelope-v1",
        materialBudgetPolicyVersion: MATERIAL_BUDGET_POLICY_VERSION,
        promptPolicyVersion: "test-prompt-policy-v1",
        wrapperContractId: claudeConfigFixture.wrapperContractId,
        wrapperParserVersion: claudeConfigFixture.wrapperParserVersion
      });
      for (const field of ["reviewMaterialHash", "promptHash", "finalStdinHash", "materialBudgetLedgerHash"]) {
        expect(identityAtReviewTime![field]).toMatch(/^[a-f0-9]{64}$/);
      }
      for (const field of ["exactMaterialEnvelopeByteCount", "finalPromptByteCount", "finalStdinByteCount"]) {
        expect(identityAtReviewTime![field]).toBeGreaterThan(0);
      }
      expect(JSON.parse(String(identityAtReviewTime!.materialBudgetLedgerJson))).toMatchObject({ schemaVersion: "review-material-ledger-v1" });
    });

    /**
     * Perturbs ONE field of the reviewer's preparation, but only from the
     * finalization rebuild onwards -- so the invocation row commits to the
     * original identity and the engine's independent reconstruction disagrees
     * with it by exactly one field.
     */
    class DriftingPrepareReviewer extends ApprovingClaudeReviewer {
      calls2 = 0;
      constructor(private readonly perturb: (prepared: PreparedReviewerInvocation) => PreparedReviewerInvocation) { super(); }
      override prepareInvocation(capsule: ImmutableReviewCapsule, material: PreparedReviewMaterial): PreparedReviewerInvocation {
        const prepared = testPrepareInvocation(capsule, material);
        this.calls2 += 1;
        return this.calls2 >= 2 ? this.perturb(prepared) : prepared;
      }
    }

    const preparationTampering: ReadonlyArray<readonly [string, (prepared: PreparedReviewerInvocation) => PreparedReviewerInvocation]> = [
      ["promptHash", prepared => ({ ...prepared, promptHash: "0".repeat(64) })],
      ["final prompt byte count", prepared => ({ ...prepared, finalPromptByteCount: prepared.finalPromptByteCount + 1 })],
      ["finalStdinHash", prepared => ({ ...prepared, finalStdinHash: "1".repeat(64) })],
      ["final stdin byte count", prepared => ({ ...prepared, finalStdinByteCount: prepared.finalStdinByteCount + 1 })],
      ["prompt policy version", prepared => ({ ...prepared, promptPolicyVersion: "some-other-policy-v9" })]
    ];

    it.each(preparationTampering)("refuses the verdict with ERROR when the reconstructed %s disagrees with the bound invocation", async (_label, perturb) => {
      const reviewer = new DriftingPrepareReviewer(perturb);
      const engine = new ReviewEngine(database.client, reviewer, { allowFakeExecutorDiagnosticReviews: true, artifactsRoot: database.paths.artifactsDir });
      const { sessionId } = await succeededSession();
      await promoteToAuthoritativeEligible(sessionId);
      const requested = await engine.requestReview(sessionId, projectId, "claude-cli", "tester", { reviewerConfig: claudeConfigFixture });
      const claim = await claimSpecific(engine, requested.reviewRequest.id, "owner-identity-drift");
      await engine.runClaimed(claim.reviewRequestId, claim.leaseToken);

      const finalized = await engine.getReviewRequest(requested.reviewRequest.id);
      // A malformed/impossible persisted authority state is ERROR, never
      // STALE: nothing about the world changed, so nothing may be filed away
      // as ordinary evidence drift.
      expect(finalized?.status).toBe("ERROR");
      expect(finalized?.failureCode).toBe("INVOCATION_BINDING_MISMATCH");
      expect(finalized?.invalidatedAt).toBeNull();
      expect(await database.client.reviewVerdict.findMany({ where: { reviewRequestId: requested.reviewRequest.id } })).toHaveLength(0);
      // Refused, never retried: the reviewer ran exactly once.
      expect(reviewer.callsByRequest.get(requested.reviewRequest.id)).toBe(1);
    });

    const writeOnceIdentityColumns: ReadonlyArray<readonly [string, string]> = [
      ["reviewMaterialHash", "0".repeat(64)],
      ["promptHash", "0".repeat(64)],
      ["finalStdinHash", "0".repeat(64)],
      ["materialBudgetLedgerHash", "0".repeat(64)],
      ["materialBudgetLedgerJson", '{"tampered":true}'],
      ["materialEnvelopeVersion", "review-material-envelope-v99"],
      ["materialBudgetPolicyVersion", "material-budget-policy-v99"]
    ];

    it.each(writeOnceIdentityColumns)("refuses at the database level to rewrite a bound invocation's %s", async (column, value) => {
      const engine = new ReviewEngine(database.client, new ApprovingClaudeReviewer(), { allowFakeExecutorDiagnosticReviews: true, artifactsRoot: database.paths.artifactsDir });
      const { sessionId } = await succeededSession();
      await promoteToAuthoritativeEligible(sessionId);
      const requested = await engine.requestReview(sessionId, projectId, "claude-cli", "tester", { reviewerConfig: claudeConfigFixture });
      const claim = await claimSpecific(engine, requested.reviewRequest.id, `owner-writeonce-${column}`);
      await engine.runClaimed(claim.reviewRequestId, claim.leaseToken);

      // The transmitted identity is write-once: even a direct SQL rewrite of a
      // bound value is refused, so the record of what was actually sent can
      // never be edited to match a verdict after the fact.
      await expect(database.client.$executeRawUnsafe(
        `UPDATE "ReviewInvocation" SET "${column}" = ? WHERE "reviewRequestId" = ?`, value, requested.reviewRequest.id
      )).rejects.toThrow(/write-once|immutable/);
    });

    const numericIdentityColumns: ReadonlyArray<readonly [string, number]> = [
      ["exactMaterialEnvelopeByteCount", 1],
      ["finalPromptByteCount", 1],
      ["finalStdinByteCount", 1]
    ];

    it.each(numericIdentityColumns)("refuses at the database level to rewrite a bound invocation's %s", async (column, value) => {
      const engine = new ReviewEngine(database.client, new ApprovingClaudeReviewer(), { allowFakeExecutorDiagnosticReviews: true, artifactsRoot: database.paths.artifactsDir });
      const { sessionId } = await succeededSession();
      await promoteToAuthoritativeEligible(sessionId);
      const requested = await engine.requestReview(sessionId, projectId, "claude-cli", "tester", { reviewerConfig: claudeConfigFixture });
      const claim = await claimSpecific(engine, requested.reviewRequest.id, `owner-writeonce-${column}`);
      await engine.runClaimed(claim.reviewRequestId, claim.leaseToken);

      await expect(database.client.$executeRawUnsafe(
        `UPDATE "ReviewInvocation" SET "${column}" = ? WHERE "reviewRequestId" = ?`, value, requested.reviewRequest.id
      )).rejects.toThrow(/write-once|immutable/);
    });
  });

  /**
   * The producer's LOG provenance must survive every hand-off, and its absence
   * must stop the review before a Claude process exists.
   *
   * The defect these pin: artifact validation produced a fully validated LOG
   * evidence part -- bytes, records, and the producer's own provenance -- and
   * the capsule builder then took only the raw buffer and the artifact row's
   * `truncated` flag. Everything the producer said about the COMPLETE stream
   * was dropped one function call after being proven, and the reviewer was
   * told `provenanceDisclosure.executionLog: null` about a log whose
   * provenance had just been validated.
   */
  describe("LOG producer provenance, end to end", () => {
    async function claimSpecific(engine: ReviewEngine, reviewRequestId: string, ownerId: string): Promise<{ reviewRequestId: string; leaseToken: string }> {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const claim = await engine.claimNext(ownerId);
        expect(claim).not.toBeNull();
        if (claim!.reviewRequestId === reviewRequestId) return claim!;
        await engine.runClaimed(claim!.reviewRequestId, claim!.leaseToken);
      }
      throw new Error("The target review request was never claimed.");
    }

    /** The LOG row the real ExecutionArtifactStore wrote for this session, with the provenance it recorded. */
    async function logRow(sessionId: string) {
      const row = await database.client.executionArtifact.findFirstOrThrow({ where: { sessionId, artifactType: "LOG" } });
      return { row, provenance: JSON.parse(row.provenanceJson) as LogProvenance };
    }

    /** Rewrites ONLY the LOG row's producer provenance, leaving its bytes and every other column untouched. */
    async function setLogProvenance(sessionId: string, provenance: unknown): Promise<void> {
      const { row } = await logRow(sessionId);
      await database.client.executionArtifact.update({
        where: { id: row.id },
        data: { provenanceJson: typeof provenance === "string" ? provenance : canonicalJson(provenance) }
      });
    }

    it("carries the exact validated producer provenance into the capsule, the material envelope, the disclosure, the ledger, and the invocation identities", async () => {
      const reviewer = new ApprovingClaudeReviewer();
      const engine = new ReviewEngine(database.client, reviewer, { allowFakeExecutorDiagnosticReviews: true, artifactsRoot: database.paths.artifactsDir });
      const { sessionId } = await succeededSession();
      await promoteToAuthoritativeEligible(sessionId);

      // What the producer actually wrote -- the object every layer below must
      // reproduce byte-for-byte.
      const { provenance } = await logRow(sessionId);
      expect(provenance.schemaVersion).toBe(LOG_PROVENANCE_SCHEMA_VERSION);
      expect(provenance.captureCompleteness).toBe("COMPLETE");

      const requested = await engine.requestReview(sessionId, projectId, "claude-cli", "tester", { reviewerConfig: claudeConfigFixture });
      const row = await database.client.reviewRequest.findUniqueOrThrow({ where: { id: requested.reviewRequest.id } });

      // 1. the persisted, hash-bound capsule
      const capsule = reviewInputCapsuleSchema.parse(JSON.parse(row.reviewInputJson));
      expect(capsule.executionLogEvidence.producerProvenance).toEqual(provenance);
      expect(computeReviewInputHash(capsule)).toBe(row.reviewInputHash);

      // 2. the material envelope built from that capsule -- core, disclosure, ledger
      const sections = buildReviewMaterialSections(capsule, TEST_POLICY_PROMPT, row.requestHash);
      expect(sections.envelope.core.provenanceDisclosure.executionLog).toEqual(provenance);
      expect((sections.envelope.core.executionLogEvidence as { producerProvenance: unknown }).producerProvenance).toEqual(provenance);

      // 3. the byte ledger charges the disclosure that carries it, and the
      //    request is bound to exactly this ledger.
      const provenanceEntry = sections.ledger.sectionEntries.find(entry => entry.sectionId === "provenanceDisclosure");
      expect(provenanceEntry?.serializedBytes).toBe(sections.ledger.provenanceByteCount);
      expect(row.materialBudgetLedgerHash).toBe(sections.ledgerHash);
      // The ledger measures the disclosure that CARRIES the provenance: drop
      // the provenance and the charged size changes, so the bound ledger hash
      // could not survive it.
      const withoutProvenance = buildReviewMaterialSections(
        { ...capsule, executionLogEvidence: { ...capsule.executionLogEvidence, producerProvenance: null } },
        TEST_POLICY_PROMPT, row.requestHash
      );
      expect(withoutProvenance.ledger.provenanceByteCount).toBeLessThan(sections.ledger.provenanceByteCount);
      expect(withoutProvenance.ledgerHash).not.toBe(row.materialBudgetLedgerHash);

      // 4. the invocation identities committed BEFORE the reviewer ran
      const claim = await claimSpecific(engine, requested.reviewRequest.id, "owner-provenance-flow");
      await engine.runClaimed(claim.reviewRequestId, claim.leaseToken);
      const invocation = await database.client.reviewInvocation.findUniqueOrThrow({ where: { reviewRequestId: requested.reviewRequest.id } });
      expect(invocation.reviewMaterialHash).toBe(sections.materialHash);
      expect(invocation.materialBudgetLedgerHash).toBe(sections.ledgerHash);

      // 5. finalization reconstructs the same provenance and accepts the verdict
      const finalized = await engine.getReviewRequest(requested.reviewRequest.id);
      expect([finalized?.status, finalized?.failureCode]).toEqual(["APPROVED", null]);
    });

    /**
     * Every case below leaves the LOG bytes exactly as the producer wrote
     * them and breaks only what the row SAYS about them. None may reach a
     * reviewer: no ReviewRequest row, no ReviewInvocation, no ReviewVerdict.
     */
    it.each([
      ["provenance is absent", () => "{}", /carries no producer provenance/],
      ["provenance is malformed JSON", () => "{not json", /not valid JSON/],
      [
        "completeness is TRUNCATED_UNKNOWN",
        (provenance: LogProvenance) => ({ ...provenance, captureCompleteness: "TRUNCATED_UNKNOWN", fullRawContentHash: null, recordCountOriginal: null }),
        /UNKNOWN capture completeness/
      ],
      [
        "the included-content hash does not describe the bytes",
        (provenance: LogProvenance) => ({ ...provenance, includedContentHash: "0".repeat(64) }),
        /includedContentHash is not the hash of the exact validated included bytes/
      ],
      [
        "the raw byte counts are inconsistent",
        (provenance: LogProvenance) => ({ ...provenance, originalRawByteCount: provenance.originalRawByteCount + 64 }),
        /versioned contract|do not add up/
      ],
      [
        "producerTruncated is claimed with nothing omitted",
        (provenance: LogProvenance) => ({ ...provenance, producerTruncated: true, truncationMethod: "TAIL", captureCompleteness: "TRUNCATED_KNOWN" }),
        /versioned contract|omitted-byte provenance/
      ],
      [
        "the included record count disagrees with the records present",
        (provenance: LogProvenance) => ({ ...provenance, recordCountIncluded: provenance.recordCountIncluded + 3, recordCountOriginal: provenance.recordCountIncluded + 3 }),
        /recordCountIncluded \d+ vs \d+ validated NDJSON record\(s\)/
      ]
    ] as ReadonlyArray<readonly [string, (provenance: LogProvenance) => unknown, RegExp]>)(
      "refuses an AUTHORITATIVE review when %s, with no request, no invocation and no verdict",
      async (_label, mutate, expected) => {
        const reviewer = new TrackingClaudeReviewer();
        const engine = new ReviewEngine(database.client, reviewer, { allowFakeExecutorDiagnosticReviews: true, artifactsRoot: database.paths.artifactsDir });
        const { sessionId } = await succeededSession();
        await promoteToAuthoritativeEligible(sessionId);
        const { provenance } = await logRow(sessionId);
        await setLogProvenance(sessionId, mutate(provenance));

        await expect(engine.requestReview(sessionId, projectId, "claude-cli", "tester", { reviewerConfig: claudeConfigFixture })).rejects.toThrow(expected);
        expect(await database.client.reviewRequest.findMany({ where: { executionSessionId: sessionId } })).toHaveLength(0);
        expect(await database.client.reviewInvocation.count({ where: { reviewRequest: { executionSessionId: sessionId } } })).toBe(0);
        expect(await database.client.reviewVerdict.count({ where: { reviewRequest: { executionSessionId: sessionId } } })).toBe(0);
        expect(reviewer.called).toBe(false);
      }
    );

    /**
     * The row and the provenance are two records of ONE log. Each passes its
     * own validation here; only comparing them shows they describe different
     * producer streams, and neither may be preferred over the other.
     */
    it("refuses an AUTHORITATIVE review when the artifact row and the producer provenance describe different streams (999 bytes HEAD_AND_TAIL versus 1 byte TAIL)", async () => {
      const reviewer = new TrackingClaudeReviewer();
      const engine = new ReviewEngine(database.client, reviewer, { allowFakeExecutorDiagnosticReviews: true, artifactsRoot: database.paths.artifactsDir });
      const { sessionId } = await succeededSession();
      await promoteToAuthoritativeEligible(sessionId);

      const { row, provenance } = await logRow(sessionId);
      const includedByteCount = row.byteCount;
      const fullStreamHash = createHash("sha256").update("a hypothetical complete stream").digest("hex");
      await database.client.executionArtifact.update({
        where: { id: row.id },
        data: {
          // The ROW: N included, 999 omitted, cut HEAD_AND_TAIL.
          truncated: true, originalByteCount: includedByteCount + 999, omittedByteCount: 999,
          truncationMethod: "HEAD_AND_TAIL", fullContentSha256: fullStreamHash,
          // The PROVENANCE: N included, 1 omitted, cut TAIL. Internally valid,
          // included hash still matches the real bytes.
          provenanceJson: canonicalJson({
            ...provenance,
            originalRawByteCount: includedByteCount + 1,
            includedRawByteCount: includedByteCount,
            omittedRawByteCount: 1,
            fullRawContentHash: fullStreamHash,
            producerTruncated: true, truncationMethod: "TAIL", captureCompleteness: "TRUNCATED_KNOWN",
            recordCountOriginal: provenance.recordCountIncluded + 1
          })
        }
      });

      await expect(engine.requestReview(sessionId, projectId, "claude-cli", "tester", { reviewerConfig: claudeConfigFixture }))
        .rejects.toThrow(/describe different log streams/);

      expect(await database.client.reviewRequest.findMany({ where: { executionSessionId: sessionId } })).toHaveLength(0);
      expect(await database.client.reviewInvocation.count({ where: { reviewRequest: { executionSessionId: sessionId } } })).toBe(0);
      expect(await database.client.reviewVerdict.count({ where: { reviewRequest: { executionSessionId: sessionId } } })).toBe(0);
      expect(reviewer.called).toBe(false);

      // The refusal is audited under its own specific code, with a bounded
      // reason that names no artifact path and quotes no log content.
      const audit = await database.client.auditEvent.findFirstOrThrow({
        where: { executionSessionId: sessionId, action: "REVIEW_REQUEST_REJECTED" }, orderBy: { createdAt: "desc" }
      });
      const details = JSON.parse(audit.detailsJson) as { reason: string; failureCode?: string };
      expect(details.failureCode).toBe("LOG_PROVENANCE_ARTIFACT_MISMATCH");
      expect(details.reason).toMatch(/describe different log streams/);
      expect(details.reason).not.toMatch(/output\.ndjson|executions[\\/]/);
    });

    it("refuses a LOG whose final record was cut mid-record, even with every hash and count rebuilt around the cut bytes", async () => {
      const reviewer = new TrackingClaudeReviewer();
      const engine = new ReviewEngine(database.client, reviewer, { allowFakeExecutorDiagnosticReviews: true, artifactsRoot: database.paths.artifactsDir });
      const { sessionId } = await succeededSession();
      await promoteToAuthoritativeEligible(sessionId);

      // A coherent artifact in every respect EXCEPT that its last NDJSON
      // record is a fragment -- the case a byte-count cap used to produce and
      // every downstream consumer used to embed as a transcript.
      const { row } = await logRow(sessionId);
      const cut = `{"type":"output","message":"complete","payload":{}}\n{"type":"output","mess`;
      await writeFile(path.join(database.paths.artifactsDir, row.relativePath), cut, "utf8");
      const cutHash = createHash("sha256").update(cut).digest("hex");
      await database.client.executionArtifact.update({
        where: { id: row.id },
        data: {
          sha256: cutHash, byteCount: Buffer.byteLength(cut, "utf8"),
          fullContentSha256: cutHash, originalByteCount: Buffer.byteLength(cut, "utf8"),
          omittedByteCount: 0, truncated: false, truncationMethod: "NONE",
          provenanceJson: canonicalJson({
            schemaVersion: LOG_PROVENANCE_SCHEMA_VERSION, recordSchemaVersion: LOG_RECORD_SCHEMA_VERSION,
            originalRawByteCount: Buffer.byteLength(cut, "utf8"), includedRawByteCount: Buffer.byteLength(cut, "utf8"),
            omittedRawByteCount: 0, fullRawContentHash: cutHash, includedContentHash: cutHash,
            producerTruncated: false, truncationMethod: "NONE", captureCompleteness: "COMPLETE",
            recordCountOriginal: 2, recordCountIncluded: 2
          })
        }
      });

      await expect(engine.requestReview(sessionId, projectId, "claude-cli", "tester", { reviewerConfig: claudeConfigFixture }))
        .rejects.toThrow(/cut mid-record/);
      expect(await database.client.reviewRequest.findMany({ where: { executionSessionId: sessionId } })).toHaveLength(0);
      expect(reviewer.called).toBe(false);
    });

    it("rejects the review when the producer provenance drifts after the request, with no invocation, no reviewer call, and no verdict", async () => {
      const reviewer = new ApprovingClaudeReviewer();
      const engine = new ReviewEngine(database.client, reviewer, { allowFakeExecutorDiagnosticReviews: true, artifactsRoot: database.paths.artifactsDir });
      const { sessionId } = await succeededSession();
      await promoteToAuthoritativeEligible(sessionId);
      const requested = await engine.requestReview(sessionId, projectId, "claude-cli", "tester", { reviewerConfig: claudeConfigFixture });
      const claim = await claimSpecific(engine, requested.reviewRequest.id, "owner-provenance-drift");

      // The same bytes, now described as the surviving tail of a larger stream
      // -- internally consistent, row and provenance rewritten in lockstep, so
      // every structural check still passes. Only a rebuild of the binding can
      // see that this is no longer the log the review was authorized over.
      const { row, provenance } = await logRow(sessionId);
      const fullStreamHash = createHash("sha256").update("a hypothetical complete stream").digest("hex");
      await database.client.executionArtifact.update({
        where: { id: row.id },
        data: {
          truncated: true, omittedByteCount: 500, originalByteCount: row.byteCount + 500,
          truncationMethod: "TAIL", fullContentSha256: fullStreamHash,
          provenanceJson: canonicalJson({
            ...provenance,
            originalRawByteCount: provenance.includedRawByteCount + 500,
            omittedRawByteCount: 500,
            fullRawContentHash: fullStreamHash,
            producerTruncated: true, truncationMethod: "TAIL", captureCompleteness: "TRUNCATED_KNOWN",
            recordCountOriginal: provenance.recordCountIncluded + 4
          })
        }
      });

      await engine.runClaimed(claim.reviewRequestId, claim.leaseToken);

      const finalized = await engine.getReviewRequest(requested.reviewRequest.id);
      expect(finalized?.status).toBe("STALE");
      expect(finalized?.failureCode).toBe("EVIDENCE_CHANGED");
      expect(reviewer.callsByRequest.get(requested.reviewRequest.id)).toBeUndefined();
      expect(await database.client.reviewInvocation.findMany({ where: { reviewRequestId: requested.reviewRequest.id } })).toHaveLength(0);
      expect(await database.client.reviewVerdict.findMany({ where: { reviewRequestId: requested.reviewRequest.id } })).toHaveLength(0);
    });

    it("errors (never STALE) when the row and the provenance start disagreeing after the request, with no process, no invocation, and no verdict", async () => {
      const reviewer = new ApprovingClaudeReviewer();
      const engine = new ReviewEngine(database.client, reviewer, { allowFakeExecutorDiagnosticReviews: true, artifactsRoot: database.paths.artifactsDir });
      const { sessionId } = await succeededSession();
      await promoteToAuthoritativeEligible(sessionId);
      const requested = await engine.requestReview(sessionId, projectId, "claude-cli", "tester", { reviewerConfig: claudeConfigFixture });
      const claim = await claimSpecific(engine, requested.reviewRequest.id, "owner-row-provenance-split");

      // Only the ROW is rewritten; the provenance still describes the original
      // stream. Nothing changed "coherently" here -- the two records of this
      // log now contradict each other, which is an error state, not drift.
      const { row } = await logRow(sessionId);
      await database.client.executionArtifact.update({
        where: { id: row.id },
        data: {
          truncated: true, originalByteCount: row.byteCount + 999, omittedByteCount: 999,
          truncationMethod: "HEAD_AND_TAIL",
          fullContentSha256: createHash("sha256").update("a hypothetical complete stream").digest("hex")
        }
      });

      await engine.runClaimed(claim.reviewRequestId, claim.leaseToken);

      const finalized = await engine.getReviewRequest(requested.reviewRequest.id);
      expect(finalized?.status).toBe("ERROR");
      expect(finalized?.failureCode).toBe("LOG_PROVENANCE_ARTIFACT_MISMATCH");
      expect(finalized?.invalidatedAt).toBeNull();
      expect(reviewer.callsByRequest.get(requested.reviewRequest.id)).toBeUndefined();
      expect(await database.client.reviewInvocation.findMany({ where: { reviewRequestId: requested.reviewRequest.id } })).toHaveLength(0);
      expect(await database.client.reviewVerdict.findMany({ where: { reviewRequestId: requested.reviewRequest.id } })).toHaveLength(0);
    });

    it("refuses to finalize a verdict when the provenance disappears while the reviewer is running", async () => {
      let requestIdUnderReview: string | undefined;
      class ProvenanceErasingReviewer extends ApprovingClaudeReviewer {
        sessionId = "";
        override async review(capsule: ImmutableReviewCapsule, controls?: ReviewControls): Promise<StructuredReviewVerdict> {
          requestIdUnderReview = capsule.reviewRequestId;
          // The reviewer saw real provenance; it is erased before finalization.
          expect(capsule.executionLogEvidence.producerProvenance).not.toBeNull();
          await setLogProvenance(this.sessionId, "{}");
          return super.review(capsule, controls);
        }
      }
      const reviewer = new ProvenanceErasingReviewer();
      const engine = new ReviewEngine(database.client, reviewer, { allowFakeExecutorDiagnosticReviews: true, artifactsRoot: database.paths.artifactsDir });
      const { sessionId } = await succeededSession();
      await promoteToAuthoritativeEligible(sessionId);
      reviewer.sessionId = sessionId;
      const requested = await engine.requestReview(sessionId, projectId, "claude-cli", "tester", { reviewerConfig: claudeConfigFixture });
      const claim = await claimSpecific(engine, requested.reviewRequest.id, "owner-provenance-erased");
      await engine.runClaimed(claim.reviewRequestId, claim.leaseToken);

      expect(requestIdUnderReview).toBe(requested.reviewRequest.id);
      const finalized = await engine.getReviewRequest(requested.reviewRequest.id);
      expect(["ERROR", "STALE"]).toContain(finalized?.status);
      expect(await database.client.reviewVerdict.findMany({ where: { reviewRequestId: requested.reviewRequest.id } })).toHaveLength(0);
      // Refused, never rerun.
      expect(reviewer.callsByRequest.get(requested.reviewRequest.id)).toBe(1);
    });
  });
});
