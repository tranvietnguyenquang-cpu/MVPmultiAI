import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseHandoffText } from "@project-relay/relay-v2-domain";
import { RelayV2Orchestrator } from "@project-relay/relay-v2-orchestrator";
import { createDisposableRelayV2Database } from "@project-relay/relay-v2-persistence/testing";
import { ExecutionArtifactStore } from "./artifacts.js";
import type { CodexCapabilitySnapshot } from "./codex-capabilities.js";
import { CodexCliExecutor } from "./codex-cli-executor.js";
import { ExecutionEngine } from "./engine.js";
import { FakeExecutor } from "./fake-executor.js";
import type { ProcessRunRequest, ProcessRunner, ProcessRunnerEvent } from "./process-runner.js";
import type { VerificationCatalogRunner } from "./verification-catalog.js";
import type { GitEvidence, WorkspaceEvidenceService } from "./workspace-evidence.js";

const capability: CodexCapabilitySnapshot = {
  executorId: "codex-cli", executablePath: process.execPath, displayPath: "node.exe", version: "fixture",
  detectedAt: "2026-08-02T00:00:00.000Z", execAvailable: true, modelFlag: true,
  reasoningEffortMechanism: "UNKNOWN", sandboxModes: ["workspace-write"], approvalModes: ["never"],
  outputModes: ["jsonl"], workingDirectorySupport: true, timeoutManagedByRelay: true, cancellationManagedByRelay: true,
  authenticationStatus: "AUTHENTICATED", rawHelpHash: "a".repeat(64), supported: true, unsupportedReasons: []
};

class CodexRunnerDouble implements ProcessRunner {
  mode: "success" | "failure" | "wait" = "success";
  requests: ProcessRunRequest[] = [];
  owns(): boolean { return false; }
  async cancel(): Promise<boolean> { return true; }
  async *run(request: ProcessRunRequest, signal?: AbortSignal): AsyncIterable<ProcessRunnerEvent> {
    this.requests.push(request);
    yield { type: "started", ownership: { executionId: request.executionId, pid: 4242, processIdentity: `owned-${request.executionId}`, startedAt: "2026-08-02T00:00:00.000Z" } };
    yield { type: "stdout", message: "safe output\n" };
    if (this.mode === "wait" && !signal?.aborted) await new Promise<void>(resolve => signal?.addEventListener("abort", () => resolve(), { once: true }));
    yield { type: "exit", result: {
      exitCode: this.mode === "failure" ? 7 : this.mode === "wait" ? null : 0, signal: null,
      timedOut: false, cancelled: this.mode === "wait", outputTruncated: false, stdoutBytes: 12, stderrBytes: 0
    } };
  }
}

class ControlledTerminationRunner implements ProcessRunner {
  active = false;
  private releaseExit!: () => void;
  private readonly exitGate = new Promise<void>(resolve => { this.releaseExit = resolve; });
  owns(): boolean { return this.active; }
  async cancel(): Promise<boolean> { return this.active; }
  allowExit(): void { this.releaseExit(); }
  async *run(request: ProcessRunRequest, signal?: AbortSignal): AsyncIterable<ProcessRunnerEvent> {
    this.active = true;
    yield { type: "started", ownership: { executionId: request.executionId, pid: 4343, processIdentity: `owned-${request.executionId}`, startedAt: new Date().toISOString() } };
    if (!signal?.aborted) await new Promise<void>(resolve => signal?.addEventListener("abort", () => resolve(), { once: true }));
    await this.exitGate;
    this.active = false;
    yield { type: "exit", result: {
      exitCode: null, signal: null, timedOut: false, cancelled: true,
      outputTruncated: false, stdoutBytes: 0, stderrBytes: 0
    } };
  }
}

function evidence(workspace: string, hashCharacter: string): GitEvidence {
  return {
    repositoryRoot: workspace, branch: "relay-test", head: "1".repeat(40), dirty: false, status: [],
    stagedCount: 0, unstagedCount: 0, untrackedCount: 0, patchPreview: "", patchSha256: "0".repeat(64),
    patchTruncated: false, patchOmittedForSensitivePaths: false, capturedAt: "2026-08-02T00:00:00.000Z",
    evidenceHash: hashCharacter.repeat(64)
  };
}

describe("ExecutionEngine Codex CLI integration boundary", () => {
  let database: Awaited<ReturnType<typeof createDisposableRelayV2Database>>;
  let orchestrator: RelayV2Orchestrator;
  let workspace: string;
  let projectId: string;
  let counter = 0;

  beforeAll(async () => {
    database = await createDisposableRelayV2Database();
    orchestrator = new RelayV2Orchestrator(database.client);
    workspace = await mkdtemp(path.join(tmpdir(), "relay-v2-codex-engine-"));
    await mkdir(path.join(workspace, ".git"));
    projectId = (await orchestrator.createProject({ name: "Codex engine", localPath: workspace })).id;
  });

  afterAll(async () => { await database.cleanup(); await rm(workspace, { recursive: true, force: true }); });

  async function approvedTask(verificationOperations: string[] = [], allowDirtyWorkspace = false) {
    counter += 1;
    const normalized = parseHandoffText(JSON.stringify({
      version: 1, project: { name: "Codex engine" },
      task: { title: `Codex ${counter}`, objective: "Make the approved change", taskType: "implementation", complexity: "normal" },
      constraints: ["No deployment"], acceptanceCriteria: ["Verification passes"],
      execution: {
        executor: "codex", model: "auto", effort: "auto", reviewer: "none", requireApproval: true,
        allowSourceTransmissionToApi: false, workspaceWrite: true, nonProductionConfirmed: true,
        allowDirtyWorkspace, timeoutSeconds: 60, verificationOperations
      }
    })).normalized;
    const created = await orchestrator.createPendingTask({ projectId, normalized, source: "MANUAL", idempotencyKey: `codex-${counter}` });
    await orchestrator.approveTask(created.task.id, "test-approver");
    return created.task.id;
  }

  function createEngine(runner: CodexRunnerDouble, options: { timeoutMs?: number; verificationRunner?: VerificationCatalogRunner } = {}) {
    let captures = 0;
    const workspaceEvidence = { capture: async () => evidence(workspace, captures++ === 0 ? "b" : "c") } as unknown as WorkspaceEvidenceService;
    return new ExecutionEngine(database.client, [
      new FakeExecutor(), new CodexCliExecutor({ discovery: { discover: async () => capability }, runner })
    ], new ExecutionArtifactStore(database.paths.artifactsDir), {
      timeoutMs: options.timeoutMs ?? 500, leaseMs: 200, workspaceEvidence,
      ...(options.verificationRunner ? { verificationRunner: options.verificationRunner } : {})
    });
  }

  it("blocks a dirty baseline by default and requires the exact approved acknowledgement hash", async () => {
    const runner = new CodexRunnerDouble();
    const dirty = { ...evidence(workspace, "d"), dirty: true, status: [{
      path: "pre-existing.txt", indexStatus: "?", worktreeStatus: "?", staged: false, unstaged: false,
      untracked: true, sensitive: false, contentSha256: "e".repeat(64), byteCount: 4, binary: false
    }], untrackedCount: 1 };
    const workspaceEvidence = { capture: async () => dirty } as unknown as WorkspaceEvidenceService;
    const engine = new ExecutionEngine(database.client, [new FakeExecutor(), new CodexCliExecutor({ discovery: { discover: async () => capability }, runner })], new ExecutionArtifactStore(database.paths.artifactsDir), { workspaceEvidence });
    await expect(engine.requestExecution(await approvedTask([], true))).rejects.toThrow(/acknowledge baseline/);
    const authorized = await engine.requestExecution(await approvedTask([], true), "local-user", { dirtyBaselineAcknowledgedHash: dirty.evidenceHash });
    expect(authorized.session.dirtyBaselineAcknowledgedHash).toBe(dirty.evidenceHash);
    await engine.cancelSession(authorized.session.id);
  });

  it("runs an approved Codex test double through the engine and persists process, capsule, evidence, and artifacts", async () => {
    const runner = new CodexRunnerDouble();
    const engine = createEngine(runner);
    const queued = await engine.requestExecution(await approvedTask());
    expect(queued.session).toMatchObject({ status: "QUEUED", executorId: "codex-cli", approvedTimeoutSeconds: 60 });
    expect(queued.session.capsuleHash).toMatch(/^[a-f0-9]{64}$/);
    const claim = await engine.claimNext();
    expect(claim).not.toBeNull();
    await engine.runClaimed(claim!.sessionId, claim!.leaseToken);
    const finished = await engine.getSession(queued.session.id);
    expect(finished).toMatchObject({ status: "SUCCEEDED", processId: 4242, processExitCode: 0 });
    expect(finished?.leases.every(lease => lease.releasedAt)).toBe(true);
    expect(finished?.artifacts.map(item => item.artifactType)).toEqual(expect.arrayContaining(["CAPSULE", "BASELINE_GIT", "FINAL_GIT", "LOG"]));
    expect(runner.requests[0]?.args).not.toContain("Make the approved change");
    expect(runner.requests[0]?.stdin).toContain("Make the approved change");
  });

  it("uses the exact nonzero exit code as a failed outcome", async () => {
    const runner = new CodexRunnerDouble(); runner.mode = "failure";
    const engine = createEngine(runner);
    const queued = await engine.requestExecution(await approvedTask());
    const claim = await engine.claimNext(); await engine.runClaimed(claim!.sessionId, claim!.leaseToken);
    expect(await engine.getSession(queued.session.id)).toMatchObject({ status: "FAILED", processExitCode: 7, failureCode: "CODEX_EXIT_NONZERO" });
  });

  it("enforces an engine timeout and releases the owned workspace lease", async () => {
    const runner = new CodexRunnerDouble(); runner.mode = "wait";
    const engine = createEngine(runner, { timeoutMs: 20 });
    const queued = await engine.requestExecution(await approvedTask());
    const claim = await engine.claimNext(); await engine.runClaimed(claim!.sessionId, claim!.leaseToken);
    const finished = await engine.getSession(queued.session.id);
    expect(finished?.status).toBe("TIMED_OUT");
    expect(finished?.leases.every(lease => lease.releasedAt)).toBe(true);
  });

  it("cancels a running mocked Codex process through the engine and releases its lease", async () => {
    const runner = new CodexRunnerDouble(); runner.mode = "wait";
    const engine = createEngine(runner, { timeoutMs: 500 });
    const queued = await engine.requestExecution(await approvedTask());
    const claim = await engine.claimNext();
    const running = engine.runClaimed(claim!.sessionId, claim!.leaseToken);
    for (let attempt = 0; attempt < 100 && (await engine.getSession(queued.session.id))?.status !== "RUNNING"; attempt += 1) await new Promise(resolve => setTimeout(resolve, 2));
    await engine.cancelSession(queued.session.id);
    await running;
    const finished = await engine.getSession(queued.session.id);
    expect(finished?.status).toBe("CANCELLED");
    expect(finished?.leases.every(lease => lease.releasedAt)).toBe(true);
  });

  it("does not accept exit zero when Relay-owned verification fails", async () => {
    const runner = new CodexRunnerDouble();
    const verificationRunner = { run: async () => [{ operation: "NPM_TEST", displayCommand: "npm test", passed: false, exitCode: 1, timedOut: false, cancelled: false, summary: "npm test failed." }] } as unknown as VerificationCatalogRunner;
    const engine = createEngine(runner, { verificationRunner });
    const queued = await engine.requestExecution(await approvedTask(["NPM_TEST"]));
    const claim = await engine.claimNext(); await engine.runClaimed(claim!.sessionId, claim!.leaseToken);
    expect(await engine.getSession(queued.session.id)).toMatchObject({ status: "FAILED", processExitCode: 0, failureCode: "VERIFICATION_FAILED" });
  });

  it("blocks a successful process when protected pre-existing Git state is hidden", async () => {
    const runner = new CodexRunnerDouble();
    const baseline = { ...evidence(workspace, "d"), stashRef: null, stashListHash: "1".repeat(64) };
    const final = { ...evidence(workspace, "e"), stashRef: "2".repeat(40), stashListHash: "3".repeat(64) };
    let captures = 0;
    const workspaceEvidence = { capture: async () => captures++ === 0 ? baseline : final } as unknown as WorkspaceEvidenceService;
    const engine = new ExecutionEngine(database.client, [
      new FakeExecutor(), new CodexCliExecutor({ discovery: { discover: async () => capability }, runner })
    ], new ExecutionArtifactStore(database.paths.artifactsDir), { workspaceEvidence });
    const queued = await engine.requestExecution(await approvedTask());
    const claim = await engine.claimNext();
    await engine.runClaimed(claim!.sessionId, claim!.leaseToken);
    expect(await engine.getSession(queued.session.id)).toMatchObject({ status: "BLOCKED", failureCode: "FORBIDDEN_GIT_MUTATION" });
  });

  it("does not release the workspace lease or admit a second writer while an owned process is terminating", async () => {
    const runner = new ControlledTerminationRunner();
    const engine = new ExecutionEngine(database.client, [
      new FakeExecutor(), new CodexCliExecutor({ discovery: { discover: async () => capability }, runner })
    ], new ExecutionArtifactStore(database.paths.artifactsDir), {
      workspaceEvidence: { capture: async () => evidence(workspace, "f") } as unknown as WorkspaceEvidenceService,
      timeoutMs: 5_000, leaseMs: 1_000
    });
    const first = await engine.requestExecution(await approvedTask());
    const firstClaim = await engine.claimNext();
    const firstRun = engine.runClaimed(firstClaim!.sessionId, firstClaim!.leaseToken);
    for (let attempt = 0; attempt < 100 && !runner.active; attempt += 1) await new Promise(resolve => setTimeout(resolve, 2));
    await engine.cancelSession(first.session.id);
    const firstLease = await database.client.workspaceLease.findFirstOrThrow({ where: { sessionId: first.session.id } });
    expect(runner.active).toBe(true);
    expect(firstLease.releasedAt).toBeNull();

    const second = await engine.requestExecution(await approvedTask());
    expect(await engine.claimNext()).toBeNull();
    expect((await engine.getSession(second.session.id))?.status).toBe("WAITING_FOR_WORKSPACE");

    runner.allowExit();
    await firstRun;
    expect(runner.active).toBe(false);
    expect((await database.client.workspaceLease.findFirstOrThrow({ where: { sessionId: first.session.id } })).releasedAt).not.toBeNull();
    expect(await engine.claimNext()).not.toBeNull();
    await engine.cancelSession(second.session.id);
  });
});
