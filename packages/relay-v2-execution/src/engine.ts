import { createHash, randomUUID } from "node:crypto";
import { canonicalWorkspaceKey, redactSecrets, validateWorkspace } from "@project-relay/local-safety";
import {
  InvalidExecutionTransitionError,
  assertExecutionTransition,
  assertTaskTransition,
  canonicalJson,
  hashTaskSpec,
  executionOutcomeSchema,
  executionStatusSchema,
  executorEventSchema,
  fakeExecutorScenarioSchema,
  isTerminalExecutionStatus,
  normalizedTaskSpecSchema,
  taskStatusSchema,
  type ExecutionEventLevel,
  type ExecutionEventType,
  type ExecutionOutcome,
  type ExecutionStatus
} from "@project-relay/relay-v2-domain";
import { Prisma, type RelayV2Database } from "@project-relay/relay-v2-persistence";
import { z } from "zod";
import { ExecutionArtifactStore, type ArtifactMetadata } from "./artifacts.js";
import { SystemExecutionClock, type ExecutionClock } from "./clock.js";
import type { PreparedExecution, RelayExecutor } from "./executor-contract.js";

const activeStatuses: ExecutionStatus[] = ["QUEUED", "WAITING_FOR_WORKSPACE", "CLAIMED", "PREPARING", "RUNNING", "CANCELLATION_REQUESTED"];
const approvalSnapshotSchema = z.object({
  specHash: z.string(),
  executor: z.string(),
  model: z.string(),
  effort: z.string(),
  reviewer: z.string(),
  permissions: z.array(z.unknown()),
  task: z.unknown()
}).passthrough();
const resultPayloadSchema = z.object({
  success: z.boolean(),
  failureCode: z.string().optional(),
  changedFiles: z.array(z.string()).optional()
}).passthrough();

const sessionInclude = {
  task: true,
  project: true,
  events: { orderBy: { sequence: "asc" as const } },
  artifacts: { orderBy: { createdAt: "asc" as const } },
  leases: { orderBy: { acquiredAt: "desc" as const } },
  auditEvents: { orderBy: { createdAt: "asc" as const } }
};

export class ExecutionAuthorityError extends Error {}
export class ExecutionConflictError extends Error {}
export class ExecutionNotFoundError extends Error {}

export type ExecutionEngineOptions = {
  timeoutMs?: number;
  leaseMs?: number;
  eventPreviewBytes?: number;
  clock?: ExecutionClock;
};

export type ExecutionRequestResult = {
  session: Prisma.ExecutionSessionGetPayload<{ include: typeof sessionInclude }>;
  duplicate: boolean;
};
export type ExecutionSessionDetails = Prisma.ExecutionSessionGetPayload<{ include: typeof sessionInclude }>;

function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function permissionProjection(permissions: Array<{ permission: string; valueJson: string }>) {
  return permissions.map(item => ({ permission: item.permission, value: JSON.parse(item.valueJson) as unknown }));
}
function isUniqueFailure(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export class ExecutionEngine {
  readonly executor: RelayExecutor;
  private readonly clock: ExecutionClock;
  private readonly timeoutMs: number;
  private readonly leaseMs: number;
  private readonly eventPreviewBytes: number;
  private readonly controllers = new Map<string, AbortController>();

  constructor(
    private readonly database: RelayV2Database,
    executor: RelayExecutor,
    private readonly artifacts: ExecutionArtifactStore,
    options: ExecutionEngineOptions = {}
  ) {
    this.executor = executor;
    this.clock = options.clock ?? new SystemExecutionClock();
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.leaseMs = options.leaseMs ?? 15_000;
    this.eventPreviewBytes = options.eventPreviewBytes ?? 4_096;
    const descriptor = executor.describe();
    if (descriptor.writeCapability) throw new ExecutionAuthorityError("Milestone 2 permits only a non-writing executor.");
  }

  private boundedPayload(payload: unknown): string {
    const redacted = redactSecrets(canonicalJson(payload));
    if (Buffer.byteLength(redacted, "utf8") <= this.eventPreviewBytes) return redacted;
    return canonicalJson({ truncated: true, preview: redacted.slice(0, Math.max(0, this.eventPreviewBytes - 100)) });
  }

  private async appendEventTx(
    tx: Prisma.TransactionClient,
    sessionId: string,
    eventType: ExecutionEventType,
    level: ExecutionEventLevel,
    message: string,
    payload: unknown = {}
  ) {
    const latest = await tx.executionEvent.findFirst({ where: { sessionId }, orderBy: { sequence: "desc" }, select: { sequence: true } });
    return tx.executionEvent.create({ data: {
      id: randomUUID(), sessionId, sequence: (latest?.sequence ?? 0) + 1, eventType, level,
      message: redactSecrets(message).slice(0, 2_000), payloadJson: this.boundedPayload(payload)
    } });
  }

  private async auditTx(tx: Prisma.TransactionClient, data: {
    projectId: string; taskId: string; sessionId?: string; actor: string; action: string; riskLevel?: string; details?: unknown;
  }) {
    return tx.auditEvent.create({ data: {
      id: randomUUID(), projectId: data.projectId, taskId: data.taskId,
      ...(data.sessionId ? { executionSessionId: data.sessionId } : {}), actor: data.actor,
      action: data.action, riskLevel: data.riskLevel ?? "REVIEW", detailsJson: this.boundedPayload(data.details ?? {})
    } });
  }

  private activeForTask(taskId: string) {
    return this.database.executionSession.findFirst({ where: { taskId, status: { in: activeStatuses } }, include: sessionInclude, orderBy: { createdAt: "desc" } });
  }

  async requestExecution(taskId: string, actor = "local-user", scenario?: z.input<typeof fakeExecutorScenarioSchema>): Promise<ExecutionRequestResult> {
    const validatedScenario = fakeExecutorScenarioSchema.parse(scenario ?? {});
    const duplicate = await this.activeForTask(taskId);
    if (duplicate) return { session: duplicate, duplicate: true };

    const initial = await this.database.task.findUnique({ where: { id: taskId }, include: { project: true } });
    if (!initial) throw new ExecutionNotFoundError("Task not found.");
    let workspacePath: string;
    try {
      workspacePath = await validateWorkspace(initial.project.localPath);
      if (canonicalWorkspaceKey(workspacePath) !== initial.project.pathKey) throw new Error("The canonical workspace no longer matches the registered project path.");
    } catch (error) {
      await this.database.auditEvent.create({ data: {
        id: randomUUID(), projectId: initial.projectId, taskId, actor, action: "EXECUTION_REQUEST_REJECTED", riskLevel: "BLOCKED",
        detailsJson: this.boundedPayload({ reason: error instanceof Error ? error.message : "Workspace validation failed." })
      } });
      throw new ExecutionAuthorityError(error instanceof Error ? error.message : "Workspace validation failed.");
    }

    try {
      const outcome = await this.database.$transaction(async tx => {
      const task = await tx.task.findUnique({ where: { id: taskId }, include: {
        project: true,
        permissions: { orderBy: { ordinal: "asc" } },
        approvals: { where: { status: "APPROVED" }, orderBy: { resolvedAt: "desc" } }
      } });
      if (!task) return { error: "Task not found.", notFound: true } as const;
      const active = await tx.executionSession.findFirst({ where: { taskId, status: { in: activeStatuses } }, select: { id: true } });
      if (active) return { duplicateSessionId: active.id } as const;
      const taskStatus = taskStatusSchema.parse(task.status);
      if (taskStatus !== "APPROVED") {
        await this.auditTx(tx, { projectId: task.projectId, taskId, actor, action: "EXECUTION_REQUEST_REJECTED", details: { reason: `Task status is ${taskStatus}.` } });
        return { error: "Only an approved task can request execution." } as const;
      }
      const approval = task.approvals[0];
      const permissions = permissionProjection(task.permissions);
      const permissionsJson = canonicalJson(permissions);
      const permissionsHash = sha256(permissionsJson);
      let mismatch = "";
      if (!approval) mismatch = "No approved task approval exists.";
      else {
        const snapshot = approvalSnapshotSchema.safeParse(JSON.parse(approval.approvedSpecJson));
        const normalized = normalizedTaskSpecSchema.safeParse(JSON.parse(task.normalizedSpecJson));
        if (approval.specHash !== task.specHash) mismatch = "Approval specification hash is stale.";
        else if (!snapshot.success || snapshot.data.specHash !== task.specHash) mismatch = "Approved snapshot is invalid or stale.";
        else if (!normalized.success || hashTaskSpec(normalized.data) !== task.specHash) mismatch = "Current task specification content does not match its hash.";
        else if (canonicalJson(snapshot.data.task) !== canonicalJson(normalized.data)) mismatch = "Task specification changed after approval.";
        else if (approval.executor !== task.selectedExecutor || snapshot.data.executor !== task.selectedExecutor) mismatch = "Approved executor changed.";
        else if (approval.model !== task.selectedModel || snapshot.data.model !== task.selectedModel) mismatch = "Approved model changed.";
        else if (approval.effort !== task.selectedEffort || snapshot.data.effort !== task.selectedEffort) mismatch = "Approved effort changed.";
        else if (approval.reviewer !== task.reviewer || snapshot.data.reviewer !== task.reviewer) mismatch = "Approved reviewer changed.";
        else if (approval.permissionsJson !== permissionsJson || canonicalJson(snapshot.data.permissions) !== permissionsJson) mismatch = "Approved permissions changed.";
      }
      if (mismatch) {
        assertTaskTransition("APPROVED", "PENDING_APPROVAL");
        await tx.task.update({ where: { id: task.id }, data: { status: "PENDING_APPROVAL", approvedAt: null } });
        if (approval) await tx.approval.update({ where: { id: approval.id }, data: { status: "INVALIDATED", invalidatedAt: this.clock.now() } });
        await this.auditTx(tx, { projectId: task.projectId, taskId, actor, action: "EXECUTION_REQUEST_REJECTED", details: { reason: mismatch, returnedTo: "PENDING_APPROVAL" } });
        return { error: mismatch } as const;
      }
      assertTaskTransition("APPROVED", "QUEUED");
      const now = this.clock.now();
      const sessionId = randomUUID();
      const session = await tx.executionSession.create({ data: {
        id: sessionId, taskId: task.id, projectId: task.projectId, executorId: this.executor.id, executorConfigJson: canonicalJson(validatedScenario), status: "QUEUED", attempt: 0,
        workspacePath, workspaceKey: canonicalWorkspaceKey(workspacePath), approvedSpecHash: task.specHash,
        approvedExecutor: task.selectedExecutor, approvedModel: task.selectedModel, approvedEffort: task.selectedEffort,
        approvedReviewer: task.reviewer, approvedPermissionsHash: permissionsHash, queuedAt: now
      } });
      await tx.task.update({ where: { id: task.id }, data: { status: "QUEUED" } });
      await this.appendEventTx(tx, session.id, "EXECUTION_REQUESTED", "INFO", "Execution request authorized.", { executorId: this.executor.id, approvedSpecHash: task.specHash });
      await this.appendEventTx(tx, session.id, "SESSION_QUEUED", "INFO", "Execution session queued in SQLite.");
      await this.auditTx(tx, { projectId: task.projectId, taskId, sessionId: session.id, actor, action: "EXECUTION_REQUEST_AUTHORIZED", details: { approvedSpecHash: task.specHash, executorId: this.executor.id } });
      return { sessionId } as const;
      });
      if ("error" in outcome) {
        if (outcome.notFound) throw new ExecutionNotFoundError(outcome.error);
        throw new ExecutionAuthorityError(outcome.error);
      }
      if ("duplicateSessionId" in outcome) {
        const existing = await this.getSession(outcome.duplicateSessionId);
        if (!existing) throw new ExecutionConflictError("The active execution session disappeared during an idempotent request.");
        return { session: existing, duplicate: true };
      }
      const session = await this.getSession(outcome.sessionId);
      if (!session) throw new ExecutionNotFoundError("Created execution session was not found.");
      return { session, duplicate: false };
    } catch (error) {
      if (!isUniqueFailure(error)) throw error;
      const raced = await this.activeForTask(taskId);
      if (!raced) throw error;
      return { session: raced, duplicate: true };
    }
  }

  async claimNext(): Promise<{ sessionId: string; leaseToken: string } | null> {
    const candidate = await this.database.executionSession.findFirst({
      where: { status: { in: ["QUEUED", "WAITING_FOR_WORKSPACE"] } }, include: { project: true }, orderBy: [{ queuedAt: "asc" }, { createdAt: "asc" }]
    });
    if (!candidate) return null;
    try {
      const resolved = await validateWorkspace(candidate.workspacePath);
      if (canonicalWorkspaceKey(resolved) !== candidate.workspaceKey || candidate.project.pathKey !== candidate.workspaceKey) throw new Error("Workspace identity changed after approval.");
    } catch (error) {
      await this.blockSession(candidate.id, "WORKSPACE_INVALID", error instanceof Error ? error.message : "Workspace validation failed.");
      return null;
    }
    const now = this.clock.now();
    const token = randomUUID();
    try {
      const claimed = await this.database.$transaction(async tx => {
        const activeLease = await tx.workspaceLease.findFirst({ where: { workspaceKey: candidate.workspaceKey, releasedAt: null } });
        if (activeLease) return { waiting: true } as const;
        const changed = await tx.executionSession.updateMany({
          where: { id: candidate.id, status: candidate.status },
          data: { status: "CLAIMED", claimedAt: now, heartbeatAt: now, attempt: { increment: 1 } }
        });
        if (changed.count !== 1) return { lost: true } as const;
        await tx.workspaceLease.create({ data: {
          id: randomUUID(), workspaceKey: candidate.workspaceKey, sessionId: candidate.id, leaseToken: token,
          acquiredAt: now, heartbeatAt: now, expiresAt: new Date(now.getTime() + this.leaseMs)
        } });
        await this.appendEventTx(tx, candidate.id, "SESSION_CLAIMED", "INFO", "Execution session claimed.");
        await this.appendEventTx(tx, candidate.id, "WORKSPACE_LOCKED", "INFO", "Exclusive workspace lease acquired.", { expiresAt: new Date(now.getTime() + this.leaseMs).toISOString() });
        return { claimed: true } as const;
      });
      if ("waiting" in claimed) {
        if (candidate.status === "QUEUED") await this.database.$transaction(async tx => {
          const changed = await tx.executionSession.updateMany({ where: { id: candidate.id, status: "QUEUED" }, data: { status: "WAITING_FOR_WORKSPACE" } });
          if (changed.count) await this.appendEventTx(tx, candidate.id, "WORKSPACE_WAITING", "INFO", "Waiting for the workspace lease.");
        });
        return null;
      }
      if ("lost" in claimed) return null;
      return { sessionId: candidate.id, leaseToken: token };
    } catch (error) {
      if (!isUniqueFailure(error)) throw error;
      if (candidate.status === "QUEUED") await this.database.$transaction(async tx => {
        const changed = await tx.executionSession.updateMany({ where: { id: candidate.id, status: "QUEUED" }, data: { status: "WAITING_FOR_WORKSPACE" } });
        if (changed.count) await this.appendEventTx(tx, candidate.id, "WORKSPACE_WAITING", "INFO", "Workspace lease was won by another session.");
      });
      return null;
    }
  }

  async heartbeat(sessionId: string, leaseToken: string): Promise<boolean> {
    const now = this.clock.now();
    return this.database.$transaction(async tx => {
      const lease = await tx.workspaceLease.updateMany({
        where: { sessionId, leaseToken, releasedAt: null },
        data: { heartbeatAt: now, expiresAt: new Date(now.getTime() + this.leaseMs) }
      });
      if (!lease.count) return false;
      await tx.executionSession.update({ where: { id: sessionId }, data: { heartbeatAt: now } });
      return true;
    });
  }

  private async transition(sessionId: string, from: ExecutionStatus, to: ExecutionStatus, data: Prisma.ExecutionSessionUpdateManyMutationInput = {}) {
    assertExecutionTransition(from, to);
    const result = await this.database.executionSession.updateMany({ where: { id: sessionId, status: from }, data: { ...data, status: to } });
    if (result.count !== 1) throw new ExecutionConflictError(`Execution session was no longer ${from}.`);
  }

  private async recordArtifact(sessionId: string, metadata: ArtifactMetadata) {
    await this.database.executionArtifact.upsert({
      where: { sessionId_artifactType_relativePath: { sessionId, artifactType: metadata.artifactType, relativePath: metadata.relativePath } },
      create: { id: randomUUID(), sessionId, ...metadata },
      update: { sha256: metadata.sha256, byteCount: metadata.byteCount, truncated: metadata.truncated }
    });
  }

  async runClaimed(sessionId: string, leaseToken: string): Promise<void> {
    const session = await this.database.executionSession.findUnique({ where: { id: sessionId }, include: { task: true } });
    if (!session) throw new ExecutionNotFoundError("Execution session not found.");
    if (session.status !== "CLAIMED") {
      await this.database.$transaction(tx => this.auditTx(tx, {
        projectId: session.projectId, taskId: session.taskId, sessionId, actor: "local-runtime",
        action: "EXECUTION_INVALID_TRANSITION_ATTEMPT", details: { from: session.status, to: "PREPARING" }
      }));
      throw new InvalidExecutionTransitionError(executionStatusSchema.parse(session.status), "PREPARING");
    }
    const lease = await this.database.workspaceLease.findFirst({ where: { sessionId, leaseToken, releasedAt: null } });
    if (!lease) throw new ExecutionConflictError("The workspace lease is missing or owned by another runtime.");
    const controller = new AbortController();
    const timeoutController = new AbortController();
    this.controllers.set(sessionId, controller);
    let prepared: PreparedExecution | undefined;
    let outcome: ExecutionOutcome = { status: "failed", summary: "Execution did not produce a validated result.", failureCode: "NO_RESULT" };
    let logTruncated = false;
    let timedOut = false;
    const changedFiles = new Set<string>();
    let started = this.clock.now();
    const heartbeatTimer = setInterval(() => void this.heartbeat(sessionId, leaseToken), Math.max(25, Math.floor(this.leaseMs / 3)));
    let timeoutTask: Promise<void> = Promise.resolve();
    try {
      const validation = await this.executor.validate({
        sessionId, workspacePath: session.workspacePath, approvedExecutor: session.approvedExecutor,
        approvedModel: session.approvedModel, approvedEffort: session.approvedEffort
      });
      if (!validation.valid) throw new ExecutionAuthorityError(validation.reason);
      await this.database.$transaction(async tx => {
        assertExecutionTransition("CLAIMED", "PREPARING");
        const changed = await tx.executionSession.updateMany({ where: { id: sessionId, status: "CLAIMED" }, data: { status: "PREPARING" } });
        if (changed.count !== 1) throw new ExecutionConflictError("Execution was cancelled before preparation.");
        await this.appendEventTx(tx, sessionId, "EXECUTOR_PREPARING", "INFO", "FakeExecutor is preparing the validated context.");
      });
      const configuredScenario = fakeExecutorScenarioSchema.parse(JSON.parse(session.executorConfigJson));
      prepared = await this.executor.prepare({
        sessionId, taskId: session.taskId, projectId: session.projectId, workspacePath: session.workspacePath,
        approvedExecutor: session.approvedExecutor, approvedModel: session.approvedModel, approvedEffort: session.approvedEffort,
        title: session.task.title, objective: session.task.objective,
        scenario: configuredScenario
      });
      if ((await this.database.executionSession.findUnique({ where: { id: sessionId }, select: { status: true } }))?.status === "CANCELLATION_REQUESTED") {
        throw new DOMException("Execution cancelled during preparation.", "AbortError");
      }
      started = this.clock.now();
      const timeoutAt = new Date(started.getTime() + this.timeoutMs);
      await this.database.$transaction(async tx => {
        assertExecutionTransition("PREPARING", "RUNNING");
        const changed = await tx.executionSession.updateMany({ where: { id: sessionId, status: "PREPARING" }, data: { status: "RUNNING", startedAt: started, heartbeatAt: started, timeoutAt } });
        if (changed.count !== 1) throw new ExecutionConflictError("Execution was cancelled before start.");
        const taskStatus = taskStatusSchema.parse(session.task.status);
        assertTaskTransition(taskStatus, "RUNNING");
        await tx.task.update({ where: { id: session.taskId }, data: { status: "RUNNING" } });
        await this.appendEventTx(tx, sessionId, "EXECUTION_STARTED", "INFO", "FakeExecutor started in-process.", { timeoutAt: timeoutAt.toISOString() });
      });
      timeoutTask = this.clock.sleep(this.timeoutMs, timeoutController.signal).then(() => {
        timedOut = true;
        controller.abort(new DOMException("Execution timed out.", "TimeoutError"));
      }).catch(() => undefined);
      await this.artifacts.initializeLog(sessionId);
      let validatedResult: z.infer<typeof resultPayloadSchema> | undefined;
      for await (const rawEvent of this.executor.execute(prepared, {
        signal: controller.signal,
        now: () => this.clock.now(),
        sleep: milliseconds => this.clock.sleep(milliseconds, controller.signal)
      })) {
        const event = executorEventSchema.parse(rawEvent);
        const safeEvent = { ...event, message: redactSecrets(event.message), payload: JSON.parse(redactSecrets(JSON.stringify(event.payload))) as unknown };
        logTruncated = (await this.artifacts.appendLog(sessionId, safeEvent)) || logTruncated;
        if (event.type === "result") {
          validatedResult = resultPayloadSchema.parse(event.payload);
          for (const file of validatedResult.changedFiles ?? []) changedFiles.add(file);
          outcome = validatedResult.success
            ? { status: "succeeded", summary: safeEvent.message }
            : { status: "failed", summary: safeEvent.message, failureCode: validatedResult.failureCode ?? "EXECUTOR_FAILED" };
        } else {
          const eventType = event.type === "warning" ? "WARNING_RECEIVED" : "OUTPUT_RECEIVED";
          const level = event.type === "warning" ? "WARNING" : "INFO";
          const payload = event.payload as { changedFiles?: unknown };
          if (Array.isArray(payload.changedFiles)) for (const file of payload.changedFiles) if (typeof file === "string") changedFiles.add(file);
          await this.database.$transaction(tx => this.appendEventTx(tx, sessionId, eventType, level, safeEvent.message, safeEvent.payload));
        }
      }
      if (!validatedResult) outcome = { status: "failed", summary: "Executor stream ended without a validated result.", failureCode: "MISSING_RESULT" };
    } catch (error) {
      const current = await this.database.executionSession.findUnique({ where: { id: sessionId }, select: { status: true } });
      if (timedOut) outcome = { status: "timed_out", summary: "Execution exceeded its engine-owned timeout.", failureCode: "TIMEOUT" };
      else if (current?.status === "CANCELLATION_REQUESTED" || controller.signal.aborted) outcome = { status: "cancelled", summary: "Execution was cancelled by the user." };
      else outcome = { status: "failed", summary: "Execution engine or FakeExecutor failed.", failureCode: "ENGINE_FAILURE", failureMessage: redactSecrets(error instanceof Error ? error.message : String(error)) };
    } finally {
      timeoutController.abort();
      await timeoutTask;
      clearInterval(heartbeatTimer);
      this.controllers.delete(sessionId);
      const finalStatus = await this.database.executionSession.findUnique({ where: { id: sessionId }, select: { status: true } });
      if (finalStatus?.status === "CANCELLATION_REQUESTED" && outcome.status !== "timed_out") outcome = { status: "cancelled", summary: "Execution was cancelled by the user." };
      if (prepared && this.executor.cleanup) await this.executor.cleanup(prepared, executionOutcomeSchema.parse(outcome)).catch(() => undefined);
      await this.finalizeSession(sessionId, leaseToken, executionOutcomeSchema.parse(outcome), started, [...changedFiles], logTruncated);
    }
  }

  private async finalizeSession(sessionId: string, leaseToken: string, outcome: ExecutionOutcome, started: Date, changedFiles: string[], logTruncated: boolean) {
    const now = this.clock.now();
    const mapping = {
      succeeded: { status: "SUCCEEDED", event: "EXECUTION_SUCCEEDED", level: "INFO", task: "AWAITING_USER_ACCEPTANCE" },
      failed: { status: "FAILED", event: "EXECUTION_FAILED", level: "ERROR", task: "FAILED" },
      timed_out: { status: "TIMED_OUT", event: "EXECUTION_TIMED_OUT", level: "ERROR", task: "FAILED" },
      cancelled: { status: "CANCELLED", event: "EXECUTION_CANCELLED", level: "INFO", task: "CANCELLED" }
    } as const;
    const target = mapping[outcome.status];
    await this.database.$transaction(async tx => {
      const current = await tx.executionSession.findUniqueOrThrow({ where: { id: sessionId }, include: { task: true } });
      const currentStatus = executionStatusSchema.parse(current.status);
      if (!isTerminalExecutionStatus(currentStatus)) {
        assertExecutionTransition(currentStatus, target.status);
        await tx.executionSession.update({ where: { id: sessionId }, data: {
          status: target.status, finishedAt: now, ...(target.status === "CANCELLED" ? { cancelledAt: now } : {}),
          durationMs: Math.max(0, now.getTime() - started.getTime()), summary: redactSecrets(outcome.summary),
          ...(outcome.failureCode ? { failureCode: outcome.failureCode } : {}),
          ...(outcome.failureMessage ? { failureMessage: outcome.failureMessage } : {})
        } });
        const taskStatus = taskStatusSchema.parse(current.task.status);
        assertTaskTransition(taskStatus, target.task);
        await tx.task.update({ where: { id: current.taskId }, data: { status: target.task, ...(target.task === "CANCELLED" ? { cancelledAt: now } : {}) } });
        await this.appendEventTx(tx, sessionId, target.event, target.level, outcome.summary, { failureCode: outcome.failureCode ?? null });
      }
      const released = await tx.workspaceLease.updateMany({ where: { sessionId, leaseToken, releasedAt: null }, data: { releasedAt: now } });
      if (released.count) await this.appendEventTx(tx, sessionId, "WORKSPACE_RELEASED", "INFO", "Workspace lease released.");
    });
    const log = await this.artifacts.finalizeLog(sessionId, logTruncated);
    await this.recordArtifact(sessionId, log);
    if (changedFiles.length) await this.recordArtifact(sessionId, await this.artifacts.writeChangedFiles(sessionId, changedFiles));
  }

  async cancelSession(sessionId: string, actor = "local-user") {
    const outcome = await this.database.$transaction(async tx => {
      const session = await tx.executionSession.findUnique({ where: { id: sessionId }, include: { task: true } });
      if (!session) return { notFound: true } as const;
      const status = executionStatusSchema.parse(session.status);
      if (isTerminalExecutionStatus(status)) return { terminal: true, session } as const;
      if (status === "CANCELLATION_REQUESTED") return { requested: true, session } as const;
      await this.appendEventTx(tx, sessionId, "CANCELLATION_REQUESTED", "INFO", "Cancellation requested by the local user.");
      await this.auditTx(tx, { projectId: session.projectId, taskId: session.taskId, sessionId, actor, action: "EXECUTION_CANCELLATION_AUTHORIZED" });
      if (status === "QUEUED" || status === "WAITING_FOR_WORKSPACE") {
        assertExecutionTransition(status, "CANCELLED");
        const now = this.clock.now();
        await tx.executionSession.update({ where: { id: sessionId }, data: { status: "CANCELLED", cancelledAt: now, finishedAt: now, durationMs: 0, summary: "Execution cancelled before claim." } });
        const taskStatus = taskStatusSchema.parse(session.task.status);
        assertTaskTransition(taskStatus, "CANCELLED");
        await tx.task.update({ where: { id: session.taskId }, data: { status: "CANCELLED", cancelledAt: now } });
        await this.appendEventTx(tx, sessionId, "EXECUTION_CANCELLED", "INFO", "Execution cancelled before it acquired a workspace lease.");
        return { cancelled: true } as const;
      }
      if (status === "CLAIMED" && !this.controllers.has(sessionId)) {
        assertExecutionTransition("CLAIMED", "CANCELLATION_REQUESTED");
        assertExecutionTransition("CANCELLATION_REQUESTED", "CANCELLED");
        const now = this.clock.now();
        await tx.executionSession.update({ where: { id: sessionId }, data: { status: "CANCELLED", cancelledAt: now, finishedAt: now, durationMs: 0, summary: "Execution cancelled after claim and before preparation." } });
        const taskStatus = taskStatusSchema.parse(session.task.status);
        assertTaskTransition(taskStatus, "CANCELLED");
        await tx.task.update({ where: { id: session.taskId }, data: { status: "CANCELLED", cancelledAt: now } });
        await this.appendEventTx(tx, sessionId, "EXECUTION_CANCELLED", "INFO", "Execution cancelled before executor preparation.");
        const released = await tx.workspaceLease.updateMany({ where: { sessionId, releasedAt: null }, data: { releasedAt: now } });
        if (released.count) await this.appendEventTx(tx, sessionId, "WORKSPACE_RELEASED", "INFO", "Workspace lease released.");
        return { cancelled: true } as const;
      }
      assertExecutionTransition(status, "CANCELLATION_REQUESTED");
      await tx.executionSession.update({ where: { id: sessionId }, data: { status: "CANCELLATION_REQUESTED" } });
      return { requested: true, session } as const;
    });
    if ("notFound" in outcome) throw new ExecutionNotFoundError("Execution session not found.");
    if ("terminal" in outcome) return { alreadyTerminal: true, session: outcome.session };
    if ("requested" in outcome) {
      await this.executor.cancel?.(sessionId);
      this.controllers.get(sessionId)?.abort(new DOMException("Execution cancelled.", "AbortError"));
    }
    return { alreadyTerminal: false, session: await this.getSession(sessionId) };
  }

  private async blockSession(sessionId: string, failureCode: string, failureMessage: string) {
    await this.database.$transaction(async tx => {
      const session = await tx.executionSession.findUnique({ where: { id: sessionId }, include: { task: true } });
      if (!session) return;
      const status = executionStatusSchema.parse(session.status);
      if (isTerminalExecutionStatus(status)) return;
      assertExecutionTransition(status, "BLOCKED");
      const now = this.clock.now();
      await tx.executionSession.update({ where: { id: sessionId }, data: { status: "BLOCKED", finishedAt: now, failureCode, failureMessage: redactSecrets(failureMessage) } });
      const taskStatus = taskStatusSchema.parse(session.task.status);
      assertTaskTransition(taskStatus, "BLOCKED");
      await tx.task.update({ where: { id: session.taskId }, data: { status: "BLOCKED" } });
      await this.appendEventTx(tx, sessionId, "EXECUTION_FAILED", "ERROR", failureMessage, { failureCode });
    });
  }

  async recoverStaleSessions(actor = "local-runtime"): Promise<number> {
    const now = this.clock.now();
    const leases = await this.database.workspaceLease.findMany({ where: { releasedAt: null, expiresAt: { lt: now } }, include: { session: true } });
    let recovered = 0;
    for (const lease of leases) {
      const heartbeat = lease.session.heartbeatAt ?? lease.heartbeatAt;
      if (heartbeat >= lease.expiresAt) continue;
      const didRecover = await this.database.$transaction(async tx => {
        const released = await tx.workspaceLease.updateMany({ where: { id: lease.id, sessionId: lease.sessionId, leaseToken: lease.leaseToken, releasedAt: null, expiresAt: { lt: now } }, data: { releasedAt: now } });
        if (!released.count) return false;
        const status = executionStatusSchema.parse(lease.session.status);
        if (!isTerminalExecutionStatus(status)) {
          assertExecutionTransition(status, "BLOCKED");
          await tx.executionSession.update({ where: { id: lease.sessionId }, data: { status: "BLOCKED", finishedAt: now, failureCode: "STALE_LEASE", failureMessage: "Runtime ownership expired before a terminal result was recorded." } });
          const task = await tx.task.findUniqueOrThrow({ where: { id: lease.session.taskId } });
          const taskStatus = taskStatusSchema.parse(task.status);
          assertTaskTransition(taskStatus, "BLOCKED");
          await tx.task.update({ where: { id: task.id }, data: { status: "BLOCKED" } });
          await this.appendEventTx(tx, lease.sessionId, "STALE_SESSION_RECOVERED", "WARNING", "Stale runtime ownership was recovered conservatively.");
          await this.appendEventTx(tx, lease.sessionId, "WORKSPACE_RELEASED", "INFO", "Expired workspace lease released.");
          await this.auditTx(tx, { projectId: lease.session.projectId, taskId: lease.session.taskId, sessionId: lease.sessionId, actor, action: "EXECUTION_STALE_RECOVERY", riskLevel: "REVIEW", details: { leaseId: lease.id } });
        }
        return true;
      });
      if (didRecover) recovered += 1;
    }
    return recovered;
  }

  listSessions(projectId?: string) {
    return this.database.executionSession.findMany({ where: projectId ? { projectId } : {}, include: { task: true, project: true, artifacts: true, leases: { orderBy: { acquiredAt: "desc" } } }, orderBy: { createdAt: "desc" } });
  }
  getSession(id: string): Promise<ExecutionSessionDetails | null> { return this.database.executionSession.findUnique({ where: { id }, include: sessionInclude }); }
  listEvents(sessionId: string, afterSequence = 0, limit = 100) {
    return this.database.executionEvent.findMany({ where: { sessionId, sequence: { gt: afterSequence } }, orderBy: { sequence: "asc" }, take: Math.min(Math.max(limit, 1), 250) });
  }
  listWorkspaceLeases() { return this.database.workspaceLease.findMany({ include: { session: { include: { task: true, project: true } } }, orderBy: { acquiredAt: "desc" } }); }
  async timeline(sessionId: string) {
    const session = await this.getSession(sessionId);
    if (!session) throw new ExecutionNotFoundError("Execution session not found.");
    return [
      ...session.events.map(event => ({ kind: "execution" as const, at: event.createdAt, sequence: event.sequence, type: event.eventType, level: event.level, message: event.message, payloadJson: event.payloadJson })),
      ...session.auditEvents.map(event => ({ kind: "audit" as const, at: event.createdAt, sequence: null, type: event.action, level: event.riskLevel, message: "Security and authority audit event.", payloadJson: event.detailsJson }))
    ].sort((left, right) => left.at.getTime() - right.at.getTime() || ((left.sequence ?? Number.MAX_SAFE_INTEGER) - (right.sequence ?? Number.MAX_SAFE_INTEGER)));
  }
}
