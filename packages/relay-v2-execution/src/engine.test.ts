import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseHandoffText, type NormalizedTaskSpec } from "@project-relay/relay-v2-domain";
import { createDisposableRelayV2Database } from "@project-relay/relay-v2-persistence/testing";
import { RelayV2Orchestrator } from "@project-relay/relay-v2-orchestrator";
import { ExecutionArtifactStore } from "./artifacts.js";
import { ExecutionAuthorityError, ExecutionEngine } from "./engine.js";
import { FakeExecutor } from "./fake-executor.js";
import { ExecutionRuntimeHost } from "./runtime-host.js";

const handoff = {
  version: 1,
  project: { name: "Execution Test" },
  task: { title: "Execute fake work", objective: "Exercise the provider-neutral engine", taskType: "implementation", complexity: "normal" },
  constraints: ["Do not modify source files"],
  acceptanceCriteria: ["Fake execution reaches a validated result"],
  execution: { executor: "fake", model: "auto", effort: "medium", reviewer: "claude", requireApproval: true, allowSourceTransmissionToApi: false }
};

describe("Relay v2 execution engine", () => {
  let database: Awaited<ReturnType<typeof createDisposableRelayV2Database>>;
  let orchestrator: RelayV2Orchestrator;
  let engine: ExecutionEngine;
  let workspace: string;
  let projectId: string;
  let counter = 0;

  beforeAll(async () => {
    database = await createDisposableRelayV2Database();
    orchestrator = new RelayV2Orchestrator(database.client);
    workspace = await mkdtemp(path.join(tmpdir(), "relay-v2-execution-workspace-"));
    await mkdir(path.join(workspace, ".git"));
    projectId = (await orchestrator.createProject({ name: "Execution Test", localPath: workspace })).id;
    engine = new ExecutionEngine(database.client, new FakeExecutor(), new ExecutionArtifactStore(database.paths.artifactsDir, 1_024), { timeoutMs: 100, leaseMs: 100 });
  }, 30_000);

  afterAll(async () => {
    await database.cleanup();
    await rm(workspace, { recursive: true, force: true });
  });

  function spec(): NormalizedTaskSpec { return parseHandoffText(JSON.stringify(handoff)).normalized; }
  async function task(approved = true) {
    counter += 1;
    const created = await orchestrator.createPendingTask({ projectId, normalized: spec(), source: "MANUAL", idempotencyKey: `execution-${counter}` });
    if (approved) await orchestrator.approveTask(created.task.id, "test-approver");
    return created.task.id;
  }

  async function waitForStatus(sessionId: string, status: string) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await engine.getSession(sessionId))?.status === status) return;
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    throw new Error(`Session did not reach ${status}.`);
  }

  it("creates exactly one queued session from a valid approved snapshot", async () => {
    const taskId = await task();
    const result = await engine.requestExecution(taskId);
    expect(result).toMatchObject({ duplicate: false, session: { taskId, status: "QUEUED", executorId: "fake", attempt: 0 } });
    expect(result.session.events.map(event => event.eventType)).toEqual(["EXECUTION_REQUESTED", "SESSION_QUEUED"]);
    expect(await database.client.auditEvent.count({ where: { executionSessionId: result.session.id, action: "EXECUTION_REQUEST_AUTHORIZED" } })).toBe(1);
    await engine.cancelSession(result.session.id);
  });

  it("returns an active duplicate, including a concurrent request race", async () => {
    const taskId = await task();
    const results = await Promise.all([engine.requestExecution(taskId), engine.requestExecution(taskId)]);
    expect(new Set(results.map(result => result.session.id)).size).toBe(1);
    expect(results.filter(result => result.duplicate)).toHaveLength(1);
    await engine.cancelSession(results[0]!.session.id);
  });

  it("rejects unapproved and cancelled tasks", async () => {
    const pending = await task(false);
    await expect(engine.requestExecution(pending)).rejects.toBeInstanceOf(ExecutionAuthorityError);
    const cancelled = await task(false);
    await orchestrator.cancelTask(cancelled, "test");
    await expect(engine.requestExecution(cancelled)).rejects.toBeInstanceOf(ExecutionAuthorityError);
  });

  it("invalidates a stale spec hash and returns the task to pending approval", async () => {
    const taskId = await task();
    await database.client.task.update({ where: { id: taskId }, data: { specHash: "changed-after-approval" } });
    await expect(engine.requestExecution(taskId)).rejects.toThrow(/stale/i);
    expect((await database.client.task.findUniqueOrThrow({ where: { id: taskId } })).status).toBe("PENDING_APPROVAL");
  });

  it("rejects task content edited after approval even when the stored hash was not updated", async () => {
    const taskId = await task();
    const row = await database.client.task.findUniqueOrThrow({ where: { id: taskId } });
    const normalized = JSON.parse(row.normalizedSpecJson) as NormalizedTaskSpec;
    normalized.task.objective = "Changed without updating the stored hash";
    await database.client.task.update({ where: { id: taskId }, data: { normalizedSpecJson: JSON.stringify(normalized) } });
    await expect(engine.requestExecution(taskId)).rejects.toThrow(/content does not match/i);
    expect((await database.client.task.findUniqueOrThrow({ where: { id: taskId } })).status).toBe("PENDING_APPROVAL");
  });

  it.each([
    ["selectedExecutor", "CODEX"], ["selectedModel", "changed-model"], ["selectedEffort", "HIGH"], ["reviewer", "NONE"]
  ] as const)("invalidates approval when %s changes", async (field, value) => {
    const taskId = await task();
    await database.client.task.update({ where: { id: taskId }, data: { [field]: value } });
    await expect(engine.requestExecution(taskId)).rejects.toThrow(/changed/i);
    expect((await database.client.task.findUniqueOrThrow({ where: { id: taskId } })).status).toBe("PENDING_APPROVAL");
  });

  it("invalidates approval when permissions change", async () => {
    const taskId = await task();
    const permission = await database.client.taskPermission.findFirstOrThrow({ where: { taskId } });
    await database.client.taskPermission.update({ where: { id: permission.id }, data: { valueJson: "true" } });
    await expect(engine.requestExecution(taskId)).rejects.toThrow(/permissions changed/i);
  });

  it("atomically claims one session during a concurrent claim race", async () => {
    const request = await engine.requestExecution(await task());
    const secondEngine = new ExecutionEngine(database.client, new FakeExecutor(), new ExecutionArtifactStore(database.paths.artifactsDir), { leaseMs: 100 });
    const claims = await Promise.all([engine.claimNext(), secondEngine.claimNext()]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect((await engine.getSession(request.session.id))?.status).toBe("CLAIMED");
    const claim = claims.find(Boolean)!;
    await engine.runClaimed(claim.sessionId, claim.leaseToken);
  });

  it("allows one workspace writer, waits a second session, and releases for the next claim", async () => {
    const first = await engine.requestExecution(await task(), "test", { eventCount: 1, outcome: "success", changedFiles: ["simulated.ts"] });
    const second = await engine.requestExecution(await task());
    const claim = await engine.claimNext();
    expect(claim?.sessionId).toBe(first.session.id);
    expect(await engine.claimNext()).toBeNull();
    expect((await engine.getSession(second.session.id))?.status).toBe("WAITING_FOR_WORKSPACE");
    await engine.runClaimed(claim!.sessionId, claim!.leaseToken);
    expect((await engine.getSession(first.session.id))?.status).toBe("SUCCEEDED");
    expect((await engine.getSession(first.session.id))?.leases[0]?.releasedAt).not.toBeNull();
    const secondClaim = await engine.claimNext();
    expect(secondClaim?.sessionId).toBe(second.session.id);
    await engine.runClaimed(secondClaim!.sessionId, secondClaim!.leaseToken);
  });

  it("renews a lease heartbeat and conservatively recovers an expired owner", async () => {
    const request = await engine.requestExecution(await task());
    const claim = await engine.claimNext();
    expect(claim).not.toBeNull();
    const before = await database.client.workspaceLease.findFirstOrThrow({ where: { sessionId: request.session.id, releasedAt: null } });
    await new Promise(resolve => setTimeout(resolve, 2));
    expect(await engine.heartbeat(request.session.id, claim!.leaseToken)).toBe(true);
    const renewed = await database.client.workspaceLease.findUniqueOrThrow({ where: { id: before.id } });
    expect(renewed.heartbeatAt.getTime()).toBeGreaterThanOrEqual(before.heartbeatAt.getTime());
    const staleHeartbeat = new Date(Date.now() - 20_000);
    const expired = new Date(Date.now() - 10_000);
    await database.client.workspaceLease.update({ where: { id: before.id }, data: { heartbeatAt: staleHeartbeat, expiresAt: expired } });
    await database.client.executionSession.update({ where: { id: request.session.id }, data: { heartbeatAt: staleHeartbeat } });
    expect(await engine.recoverStaleSessions()).toBe(1);
    expect((await engine.getSession(request.session.id))?.status).toBe("BLOCKED");
    expect((await database.client.workspaceLease.findUniqueOrThrow({ where: { id: before.id } })).releasedAt).not.toBeNull();
  });

  it("preserves queued work across an engine restart", async () => {
    const request = await engine.requestExecution(await task(), "test", { outcome: "failure", eventCount: 0, summary: "Persisted restart scenario" });
    const restarted = new ExecutionEngine(database.client, new FakeExecutor(), new ExecutionArtifactStore(database.paths.artifactsDir));
    const claim = await restarted.claimNext();
    expect(claim?.sessionId).toBe(request.session.id);
    await restarted.runClaimed(claim!.sessionId, claim!.leaseToken);
    expect((await restarted.getSession(request.session.id))?.status).toBe("FAILED");
  });

  it("persists deterministic warnings, redacted logs, changed-file metadata, hashes, and ordered events", async () => {
    const beforeWorkspace = await readdir(workspace);
    const request = await engine.requestExecution(await task(), "test", {
      outcome: "success", eventCount: 3, warningAt: [1], changedFiles: ["fake-change.ts"], summary: "token=abcdefghijklmnop"
    });
    const claim = await engine.claimNext();
    await engine.runClaimed(claim!.sessionId, claim!.leaseToken);
    const session = await engine.getSession(request.session.id);
    expect(session?.status).toBe("SUCCEEDED");
    expect(session?.events.map(event => event.sequence)).toEqual(session?.events.map((_, index) => index + 1));
    expect(session?.events.some(event => event.eventType === "WARNING_RECEIVED")).toBe(true);
    expect(session?.events.map(event => event.message).join(" ")).not.toContain("abcdefghijklmnop");
    expect(session?.artifacts.map(item => item.artifactType)).toEqual(expect.arrayContaining(["LOG", "CHANGED_FILES"]));
    expect(session?.artifacts.every(item => /^[a-f0-9]{64}$/.test(item.sha256) && item.byteCount >= 0)).toBe(true);
    expect(await readdir(workspace)).toEqual(beforeWorkspace);
  });

  it("bounds oversized SQLite event previews while retaining valid JSON", async () => {
    const previewEngine = new ExecutionEngine(database.client, new FakeExecutor(), new ExecutionArtifactStore(database.paths.artifactsDir), { eventPreviewBytes: 120 });
    const request = await previewEngine.requestExecution(await task(), "test", { eventCount: 1, changedFiles: ["x".repeat(400)] });
    const claim = await previewEngine.claimNext();
    await previewEngine.runClaimed(claim!.sessionId, claim!.leaseToken);
    const output = (await previewEngine.getSession(request.session.id))?.events.find(event => event.eventType === "OUTPUT_RECEIVED");
    expect(JSON.parse(output!.payloadJson)).toMatchObject({ truncated: true });
    expect(Buffer.byteLength(output!.payloadJson, "utf8")).toBeLessThanOrEqual(120);
  });

  it("marks a validated fake failure as failed", async () => {
    const request = await engine.requestExecution(await task(), "test", { outcome: "failure", eventCount: 1, summary: "Expected fake failure" });
    const claim = await engine.claimNext();
    await engine.runClaimed(claim!.sessionId, claim!.leaseToken);
    expect(await engine.getSession(request.session.id)).toMatchObject({ status: "FAILED", failureCode: "FAKE_FAILURE" });
  });

  it("enforces an engine-owned timeout and always releases the lease", async () => {
    const timeoutEngine = new ExecutionEngine(database.client, new FakeExecutor(), new ExecutionArtifactStore(database.paths.artifactsDir), { timeoutMs: 10, leaseMs: 100 });
    const request = await timeoutEngine.requestExecution(await task(), "test", { outcome: "timeout", eventCount: 0, delayMs: 1 });
    const claim = await timeoutEngine.claimNext();
    await timeoutEngine.runClaimed(claim!.sessionId, claim!.leaseToken);
    const session = await timeoutEngine.getSession(request.session.id);
    expect(session?.status).toBe("TIMED_OUT");
    expect(session?.leases[0]?.releasedAt).not.toBeNull();
  });

  it("cancels queued work idempotently", async () => {
    const request = await engine.requestExecution(await task());
    const first = await engine.cancelSession(request.session.id);
    const second = await engine.cancelSession(request.session.id);
    expect(first.alreadyTerminal).toBe(false);
    expect(second.alreadyTerminal).toBe(true);
    expect((await engine.getSession(request.session.id))?.status).toBe("CANCELLED");
  });

  it("cancels a claimed session before preparation and releases its lease", async () => {
    const request = await engine.requestExecution(await task());
    await engine.claimNext();
    await engine.cancelSession(request.session.id);
    const session = await engine.getSession(request.session.id);
    expect(session?.status).toBe("CANCELLED");
    expect(session?.leases[0]?.releasedAt).not.toBeNull();
  });

  it("cancels a workspace-waiting session without disturbing the active owner", async () => {
    const owner = await engine.requestExecution(await task());
    const waiting = await engine.requestExecution(await task());
    const claim = await engine.claimNext();
    expect(claim?.sessionId).toBe(owner.session.id);
    await engine.claimNext();
    expect((await engine.getSession(waiting.session.id))?.status).toBe("WAITING_FOR_WORKSPACE");
    await engine.cancelSession(waiting.session.id);
    expect((await engine.getSession(waiting.session.id))?.status).toBe("CANCELLED");
    expect((await engine.getSession(owner.session.id))?.leases[0]?.releasedAt).toBeNull();
    await engine.runClaimed(claim!.sessionId, claim!.leaseToken);
  });

  it("cancels running FakeExecutor work and releases the lease", async () => {
    const request = await engine.requestExecution(await task(), "test", { outcome: "cancellation", eventCount: 1, delayMs: 1 });
    const claim = await engine.claimNext();
    const running = engine.runClaimed(claim!.sessionId, claim!.leaseToken);
    await waitForStatus(request.session.id, "RUNNING");
    await engine.cancelSession(request.session.id);
    await running;
    const session = await engine.getSession(request.session.id);
    expect(session?.status).toBe("CANCELLED");
    expect(session?.leases[0]?.releasedAt).not.toBeNull();
  });

  it("stops the runtime host cleanly by cancelling its in-process active session", async () => {
    const request = await engine.requestExecution(await task(), "test", { outcome: "cancellation", eventCount: 1, delayMs: 1 });
    const host = new ExecutionRuntimeHost(engine, { pollMs: 5 });
    const tick = host.tick();
    await waitForStatus(request.session.id, "RUNNING");
    await host.stop();
    await tick;
    expect((await engine.getSession(request.session.id))?.status).toBe("CANCELLED");
  });

  it("enforces append-only execution events", async () => {
    const request = await engine.requestExecution(await task());
    const event = request.session.events[0]!;
    await expect(database.client.executionEvent.update({ where: { id: event.id }, data: { message: "mutated" } })).rejects.toThrow(/append-only/i);
    await expect(database.client.executionEvent.delete({ where: { id: event.id } })).rejects.toThrow(/append-only/i);
    await engine.cancelSession(request.session.id);
  });

  it("rejects and audits an invalid application-service transition", async () => {
    const request = await engine.requestExecution(await task());
    await expect(engine.runClaimed(request.session.id, "not-a-lease")).rejects.toThrow(/cannot transition/i);
    expect(await database.client.auditEvent.count({ where: { executionSessionId: request.session.id, action: "EXECUTION_INVALID_TRANSITION_ATTEMPT" } })).toBe(1);
    await engine.cancelSession(request.session.id);
  });
});
