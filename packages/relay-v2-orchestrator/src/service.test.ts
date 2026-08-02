import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseHandoffText, type NormalizedTaskSpec } from "@project-relay/relay-v2-domain";
import { createDisposableRelayV2Database } from "@project-relay/relay-v2-persistence/testing";
import { createLegacyPreviewReport } from "./legacy-report.js";
import { RelayV2Orchestrator } from "./service.js";

const handoff = {
  version: 1,
  project: { name: "Relay Test" },
  task: { title: "Create inbox", objective: "Build the pending task inbox", taskType: "implementation", complexity: "normal", context: "Milestone 1" },
  constraints: ["Do not execute agents"],
  acceptanceCriteria: ["Task is pending approval"],
  execution: { executor: "codex", model: "auto", effort: "medium", reviewer: "claude", requireApproval: true, allowSourceTransmissionToApi: false }
};

describe("Relay v2 Milestone 1 orchestrator", () => {
  let database: Awaited<ReturnType<typeof createDisposableRelayV2Database>>;
  let orchestrator: RelayV2Orchestrator;
  let projectId: string;
  let workspace: string;

  beforeAll(async () => {
    database = await createDisposableRelayV2Database();
    orchestrator = new RelayV2Orchestrator(database.client);
    workspace = await mkdtemp(path.join(tmpdir(), "relay-v2-workspace-"));
    await mkdir(path.join(workspace, ".git"));
    const project = await orchestrator.createProject({ name: "Relay Test", localPath: workspace });
    projectId = project.id;
  }, 30_000);

  afterAll(async () => {
    await database.cleanup();
    await rm(workspace, { recursive: true, force: true });
  });

  function spec(): NormalizedTaskSpec {
    return parseHandoffText(JSON.stringify(handoff)).normalized;
  }

  it("validates a real local Git project path and audits project creation", async () => {
    const project = await orchestrator.getProject(projectId);
    expect(project?.localPath).toBe(workspace);
    expect(await database.client.auditEvent.count({ where: { projectId, action: "PROJECT_CREATED" } })).toBe(1);
  });

  it("rejects a project path that is not a Git repository", async () => {
    const notGit = await mkdtemp(path.join(tmpdir(), "relay-v2-not-git-"));
    await expect(orchestrator.createProject({ name: "Not Git", localPath: notGit })).rejects.toThrow(/Git repository/i);
    await rm(notGit, { recursive: true, force: true });
  });

  it("retries a concurrent project slug collision after Prisma P2002", async () => {
    const firstWorkspace = await mkdtemp(path.join(tmpdir(), "relay-v2-slug-a-"));
    const secondWorkspace = await mkdtemp(path.join(tmpdir(), "relay-v2-slug-b-"));
    await Promise.all([mkdir(path.join(firstWorkspace, ".git")), mkdir(path.join(secondWorkspace, ".git"))]);
    try {
      const projects = await Promise.all([
        orchestrator.createProject({ name: "Concurrent Slug", localPath: firstWorkspace }),
        orchestrator.createProject({ name: "Concurrent Slug", localPath: secondWorkspace })
      ]);
      expect(new Set(projects.map(project => project.slug))).toEqual(new Set(["concurrent-slug", "concurrent-slug-2"]));
      expect(await database.client.auditEvent.count({ where: { projectId: { in: projects.map(project => project.id) }, action: "PROJECT_CREATED" } })).toBe(2);
    } finally {
      await Promise.all([rm(firstWorkspace, { recursive: true, force: true }), rm(secondWorkspace, { recursive: true, force: true })]);
    }
  });

  it("audits a handoff validation failure without persisting the payload", async () => {
    await expect(orchestrator.validateHandoff({ projectId, text: "version: 1\nproject: [broken" })).rejects.toThrow();
    const audit = await database.client.auditEvent.findFirst({ where: { projectId, action: "HANDOFF_VALIDATION_FAILED" } });
    expect(audit).not.toBeNull();
    expect(audit?.detailsJson).toContain("payloadBytes");
    expect(audit?.detailsJson).not.toContain("project: [broken");
  });

  it("creates every task as PENDING_APPROVAL with task and submission audit events", async () => {
    const result = await orchestrator.createPendingTask({ projectId, normalized: spec(), source: "MANUAL", idempotencyKey: "create-test" });
    expect(result.duplicate).toBe(false);
    expect(result.task.status).toBe("PENDING_APPROVAL");
    expect(await database.client.auditEvent.count({ where: { taskId: result.task.id, action: { in: ["TASK_CREATED", "TASK_SUBMITTED_FOR_APPROVAL"] } } })).toBe(2);
  });

  it.each(["MANUAL", "HANDOFF_JSON", "HANDOFF_YAML", "CLIPBOARD", "FILE_IMPORT"] as const)("ends the %s creation path at PENDING_APPROVAL", async source => {
    const result = await orchestrator.createPendingTask({ projectId, normalized: spec(), source, idempotencyKey: `source-${source}` });
    expect(result.task.status).toBe("PENDING_APPROVAL");
  });

  it("returns an idempotent duplicate and rejects a conflicting reuse", async () => {
    const first = await orchestrator.createPendingTask({ projectId, normalized: spec(), source: "HANDOFF_JSON", idempotencyKey: "same-key" });
    const duplicate = await orchestrator.createPendingTask({ projectId, normalized: spec(), source: "HANDOFF_JSON", idempotencyKey: "same-key" });
    expect(duplicate).toMatchObject({ duplicate: true, idempotencyKey: "same-key" });
    expect(duplicate.task.id).toBe(first.task.id);
    const changed = spec();
    changed.task.title = "Different";
    await expect(orchestrator.createPendingTask({ projectId, normalized: changed, source: "HANDOFF_JSON", idempotencyKey: "same-key" })).rejects.toThrow(/different normalized task/i);
  });

  it("prevents concurrent duplicate insertion at the database boundary", async () => {
    const input = { projectId, normalized: spec(), source: "FILE_IMPORT" as const, idempotencyKey: "concurrent-key", externalId: "external-concurrent" };
    const results = await Promise.all([orchestrator.createPendingTask(input), orchestrator.createPendingTask(input)]);
    expect(new Set(results.map(result => result.task.id)).size).toBe(1);
    expect(results.filter(result => result.duplicate)).toHaveLength(1);
  });

  it("approves the exact current task/spec/selection snapshot without creating work", async () => {
    const created = await orchestrator.createPendingTask({ projectId, normalized: spec(), source: "CLIPBOARD", idempotencyKey: "approval-key" });
    const result = await orchestrator.approveTask(created.task.id, "reviewer@example.local");
    expect(result.task.status).toBe("APPROVED");
    expect(result.approval).toMatchObject({ status: "APPROVED", specHash: created.task.specHash, executor: "CODEX", model: "AUTO", effort: "MEDIUM", reviewer: "CLAUDE" });
    const snapshot = JSON.parse(result.approval.approvedSpecJson) as { specHash: string; permissions: unknown[] };
    expect(snapshot.specHash).toBe(created.task.specHash);
    expect(snapshot.permissions).toEqual([{ permission: "ALLOW_SOURCE_TRANSMISSION_TO_API", value: false }]);
    const delegates = database.client as unknown as Record<string, unknown>;
    expect(delegates.workItem).toBeUndefined();
    expect(delegates.agentSession).toBeUndefined();
    expect(delegates.executionRun).toBeUndefined();
  });

  it("invalidates approval and returns the edited task to PENDING_APPROVAL", async () => {
    const created = await orchestrator.createPendingTask({ projectId, normalized: spec(), source: "MANUAL", idempotencyKey: "edit-key" });
    await orchestrator.approveTask(created.task.id, "approver");
    const changed = spec();
    changed.task.objective = "A changed objective requiring a new approval";
    const updated = await orchestrator.replaceTaskSpec(created.task.id, changed, "editor");
    expect(updated.task.status).toBe("PENDING_APPROVAL");
    const approvals = await database.client.approval.findMany({ where: { taskId: created.task.id }, orderBy: { requestedAt: "asc" } });
    expect(approvals.map(item => item.status)).toEqual(["INVALIDATED", "PENDING"]);
    expect(approvals[0]?.specHash).not.toBe(approvals[1]?.specHash);
  });

  it("rejects and audits an invalid transition", async () => {
    const created = await orchestrator.createPendingTask({ projectId, normalized: spec(), source: "MANUAL", idempotencyKey: "invalid-key" });
    await orchestrator.approveTask(created.task.id, "approver");
    await expect(orchestrator.approveTask(created.task.id, "approver")).rejects.toThrow(/cannot transition/i);
    expect(await database.client.auditEvent.count({ where: { taskId: created.task.id, action: "TASK_INVALID_TRANSITION_ATTEMPT" } })).toBe(1);
  });

  it("rejects an unchanged specification edit after the task is terminal", async () => {
    const created = await orchestrator.createPendingTask({ projectId, normalized: spec(), source: "MANUAL", idempotencyKey: "terminal-same-spec" });
    await orchestrator.cancelTask(created.task.id, "reviewer");
    await expect(orchestrator.replaceTaskSpec(created.task.id, spec(), "editor")).rejects.toThrow(/cannot transition/i);
    expect(await database.client.auditEvent.count({ where: { taskId: created.task.id, action: "TASK_INVALID_TRANSITION_ATTEMPT" } })).toBe(1);
  });

  it("reports legacy approvals as skipped and never converts them into v2 authorization", async () => {
    const before = await database.client.approval.count();
    const result = await createLegacyPreviewReport({
      database: database.client,
      v2ProjectId: projectId,
      legacyProjectIds: ["legacy-one"],
      reader: { readProjects: async () => [{ id: "legacy-one", name: "Legacy", approvalCount: 3, tasks: [{ id: "legacy-task", status: "PLANNED" }, { id: "ambiguous", status: "IN_PROGRESS" }] }] }
    });
    expect(result).toMatchObject({ sourceCounts: { projects: 1, tasks: 2, approvals: 3 }, candidateCounts: { projects: 1, tasks: 1 }, skippedCounts: { projects: 0, tasks: 1, approvals: 3 } });
    expect(await database.client.approval.count()).toBe(before);
    expect(result.report.status).toBe("PREVIEW_ONLY");
    expect(await database.client.auditEvent.count({ where: { projectId, action: "LEGACY_REPORT_ATTEMPTED" } })).toBe(1);
  });
});
