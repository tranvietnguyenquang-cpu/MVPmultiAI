import { randomUUID } from "node:crypto";
import path from "node:path";
import { validateWorkspace } from "@project-relay/local-safety";
import {
  HandoffValidationError,
  InvalidTaskTransitionError,
  assertTaskTransition,
  canonicalJson,
  hashTaskSpec,
  normalizedTaskSpecSchema,
  parseHandoffText,
  taskSourceSchema,
  taskStatusSchema,
  type HandoffFormat,
  type NormalizedTaskSpec,
  type TaskSource,
  type TaskStatus
} from "@project-relay/relay-v2-domain";
import { Prisma, type Project, type RelayV2Database } from "@project-relay/relay-v2-persistence";

const taskInclude = {
  project: true,
  constraints: { orderBy: { ordinal: "asc" as const } },
  acceptanceCriteria: { orderBy: { ordinal: "asc" as const } },
  permissions: { orderBy: { ordinal: "asc" as const } },
  approvals: { orderBy: { requestedAt: "desc" as const } }
};

export class RelayV2NotFoundError extends Error {}
export class RelayV2ConflictError extends Error {}

export type CreateProjectInput = {
  name: string;
  slug?: string;
  localPath: string;
  description?: string;
};

export type CreateTaskInput = {
  projectId: string;
  normalized: NormalizedTaskSpec;
  source: TaskSource;
  externalId?: string;
  idempotencyKey?: string;
  actor?: string;
};

export type CreateTaskResult = {
  task: Prisma.TaskGetPayload<{ include: typeof taskInclude }>;
  duplicate: boolean;
  idempotencyKey: string;
};

export type RelayV2TaskDetails = Prisma.TaskGetPayload<{ include: typeof taskInclude }>;
export type RelayV2TaskListItem = Prisma.TaskGetPayload<{ include: { project: true; acceptanceCriteria: true } }>;

function slugify(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "project";
}

function canonicalPathKey(value: string): string {
  return path.resolve(value).replace(/\\/g, "/").replace(/\/$/, "").toLocaleLowerCase("en-US");
}

function permissionJson(spec: NormalizedTaskSpec): string {
  return canonicalJson(spec.permissions);
}

function approvalSnapshot(spec: NormalizedTaskSpec, specHash: string): string {
  return canonicalJson({
    specHash,
    task: spec,
    executor: spec.execution.executor,
    model: spec.execution.model,
    effort: spec.execution.effort,
    reviewer: spec.execution.reviewer,
    permissions: spec.permissions
  });
}

function isUniqueFailure(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export class RelayV2Orchestrator {
  constructor(
    private readonly database: RelayV2Database,
    private readonly workspaceValidator: (workspace: string) => Promise<string> = validateWorkspace
  ) {}

  listProjects() {
    return this.database.project.findMany({ orderBy: { updatedAt: "desc" } });
  }

  async getProject(id: string): Promise<Project | null> {
    return this.database.project.findUnique({ where: { id } });
  }

  async createProject(input: CreateProjectInput) {
    const name = input.name.trim();
    if (!name) throw new RelayV2ConflictError("Project name is required.");
    const localPath = await this.workspaceValidator(input.localPath);
    const pathKey = canonicalPathKey(localPath);
    const baseSlug = slugify(input.slug?.trim() || name);
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      const slug = attempt === 0 ? baseSlug : `${baseSlug}-${attempt + 1}`;
      try {
        return await this.database.$transaction(async tx => {
          const project = await tx.project.create({
            data: {
              id: randomUUID(),
              name,
              slug,
              localPath,
              pathKey,
              description: input.description?.trim() ?? ""
            }
          });
          await tx.auditEvent.create({
            data: {
              id: randomUUID(),
              projectId: project.id,
              actor: "local-user",
              action: "PROJECT_CREATED",
              riskLevel: "SAFE",
              detailsJson: canonicalJson({ slug: project.slug })
            }
          });
          return project;
        });
      } catch (error) {
        if (!isUniqueFailure(error)) throw error;
        const existingPath = await this.database.project.findUnique({ where: { pathKey }, select: { id: true } });
        if (existingPath) throw new RelayV2ConflictError("This workspace is already registered as a Relay v2 project.");
      }
    }
    throw new RelayV2ConflictError("Could not allocate a unique project slug after repeated concurrent conflicts.");
  }

  async validateHandoff(input: { text: string; format?: "AUTO" | HandoffFormat; projectId?: string; actor?: string }) {
    try {
      return parseHandoffText(input.text, input.format);
    } catch (error) {
      if (input.projectId && error instanceof HandoffValidationError) {
        const project = await this.database.project.findUnique({ where: { id: input.projectId }, select: { id: true } });
        if (project) {
          await this.database.auditEvent.create({
            data: {
              id: randomUUID(),
              projectId: project.id,
              actor: input.actor ?? "local-user",
              action: "HANDOFF_VALIDATION_FAILED",
              riskLevel: "SAFE",
              detailsJson: canonicalJson({ issues: error.issues.slice(0, 20), payloadBytes: Buffer.byteLength(input.text, "utf8") })
            }
          });
        }
      }
      throw error;
    }
  }

  private async findDuplicate(input: CreateTaskInput & { idempotencyKey: string; specHash: string }) {
    const byKey = await this.database.task.findUnique({
      where: { projectId_source_idempotencyKey: { projectId: input.projectId, source: input.source, idempotencyKey: input.idempotencyKey } },
      include: taskInclude
    });
    if (byKey) return byKey;
    if (!input.externalId) return null;
    return this.database.task.findUnique({
      where: { projectId_source_externalId: { projectId: input.projectId, source: input.source, externalId: input.externalId } },
      include: taskInclude
    });
  }

  private async returnDuplicate(existing: NonNullable<Awaited<ReturnType<RelayV2Orchestrator["findDuplicate"]>>>, input: CreateTaskInput & { idempotencyKey: string; specHash: string }): Promise<CreateTaskResult> {
    if (existing.specHash !== input.specHash) throw new RelayV2ConflictError("The idempotency key or external ID is already associated with a different normalized task specification.");
    await this.database.auditEvent.create({
      data: {
        id: randomUUID(),
        projectId: existing.projectId,
        taskId: existing.id,
        actor: input.actor ?? "local-user",
        action: "TASK_DUPLICATE_RETURNED",
        riskLevel: "SAFE",
        detailsJson: canonicalJson({ source: input.source, idempotencyKey: input.idempotencyKey, specHash: input.specHash })
      }
    });
    return { task: existing, duplicate: true, idempotencyKey: input.idempotencyKey };
  }

  async createPendingTask(rawInput: CreateTaskInput): Promise<CreateTaskResult> {
    const source = taskSourceSchema.parse(rawInput.source);
    const normalized = normalizedTaskSpecSchema.parse(rawInput.normalized);
    const idempotencyKey = rawInput.idempotencyKey?.trim() || randomUUID();
    if (idempotencyKey.length > 200) throw new RelayV2ConflictError("idempotencyKey must be 200 characters or fewer.");
    const input = { ...rawInput, normalized, source, idempotencyKey, specHash: hashTaskSpec(normalized) };
    const project = await this.database.project.findUnique({ where: { id: input.projectId } });
    if (!project) throw new RelayV2NotFoundError("Project not found.");
    if (project.name.toLocaleLowerCase("en-US") !== input.normalized.project.name.toLocaleLowerCase("en-US")) {
      throw new RelayV2ConflictError(`The handoff names project '${input.normalized.project.name}', not '${project.name}'.`);
    }

    const existing = await this.findDuplicate(input);
    if (existing) return this.returnDuplicate(existing, input);

    try {
      const task = await this.database.$transaction(async tx => {
        const created = await tx.task.create({
          data: {
            id: randomUUID(),
            projectId: project.id,
            ...(input.externalId ? { externalId: input.externalId } : {}),
            idempotencyKey,
            title: input.normalized.task.title,
            objective: input.normalized.task.objective,
            source,
            taskType: input.normalized.task.taskType,
            complexity: input.normalized.task.complexity,
            status: "DRAFT",
            context: input.normalized.task.context,
            suggestedExecutor: input.normalized.execution.executor,
            suggestedModel: input.normalized.execution.model,
            suggestedEffort: input.normalized.execution.effort,
            selectedExecutor: input.normalized.execution.executor,
            selectedModel: input.normalized.execution.model,
            selectedEffort: input.normalized.execution.effort,
            reviewer: input.normalized.execution.reviewer,
            requireApproval: true,
            specHash: input.specHash,
            normalizedSpecJson: canonicalJson(input.normalized),
            constraints: { create: input.normalized.constraints.map((text, ordinal) => ({ id: randomUUID(), ordinal, text })) },
            acceptanceCriteria: { create: input.normalized.acceptanceCriteria.map((description, ordinal) => ({ id: randomUUID(), ordinal, description })) },
            permissions: { create: input.normalized.permissions.map((permission, ordinal) => ({ id: randomUUID(), ordinal, permission: permission.permission, valueJson: canonicalJson(permission.value) })) }
          }
        });
        assertTaskTransition("DRAFT", "PENDING_APPROVAL");
        const pending = await tx.task.update({ where: { id: created.id }, data: { status: "PENDING_APPROVAL" } });
        await tx.approval.create({
          data: {
            id: randomUUID(),
            taskId: pending.id,
            approvalType: "TASK_EXECUTION",
            requestedBy: input.actor ?? "local-user",
            status: "PENDING",
            specHash: input.specHash,
            approvedSpecJson: approvalSnapshot(input.normalized, input.specHash),
            executor: input.normalized.execution.executor,
            model: input.normalized.execution.model,
            effort: input.normalized.execution.effort,
            reviewer: input.normalized.execution.reviewer,
            permissionsJson: permissionJson(input.normalized)
          }
        });
        await tx.auditEvent.createMany({
          data: [
            { id: randomUUID(), projectId: project.id, taskId: pending.id, actor: input.actor ?? "local-user", action: "TASK_CREATED", riskLevel: "SAFE", detailsJson: canonicalJson({ source, specHash: input.specHash, externalId: input.externalId ?? null }) },
            { id: randomUUID(), projectId: project.id, taskId: pending.id, actor: input.actor ?? "local-user", action: "TASK_SUBMITTED_FOR_APPROVAL", riskLevel: "REVIEW", detailsJson: canonicalJson({ from: "DRAFT", to: "PENDING_APPROVAL", specHash: input.specHash }) }
          ]
        });
        return tx.task.findUniqueOrThrow({ where: { id: pending.id }, include: taskInclude });
      });
      return { task, duplicate: false, idempotencyKey };
    } catch (error) {
      if (!isUniqueFailure(error)) throw error;
      const raced = await this.findDuplicate(input);
      if (!raced) throw error;
      return this.returnDuplicate(raced, input);
    }
  }

  async listTasks(projectId?: string): Promise<RelayV2TaskListItem[]> {
    return this.database.task.findMany({
      ...(projectId ? { where: { projectId } } : {}),
      include: { project: true, acceptanceCriteria: { orderBy: { ordinal: "asc" } } },
      orderBy: { createdAt: "desc" }
    });
  }

  async getTask(id: string): Promise<RelayV2TaskDetails | null> {
    return this.database.task.findUnique({ where: { id }, include: taskInclude });
  }

  listTaskAudit(taskId: string) {
    return this.database.auditEvent.findMany({ where: { taskId }, orderBy: { createdAt: "asc" } });
  }

  async approveTask(taskId: string, approver: string) {
    const outcome = await this.database.$transaction(async tx => {
      const task = await tx.task.findUnique({ where: { id: taskId }, include: { permissions: { orderBy: { ordinal: "asc" } }, approvals: { orderBy: { requestedAt: "desc" } } } });
      if (!task) throw new RelayV2NotFoundError("Task not found.");
      const to: TaskStatus = "APPROVED";
      try {
        assertTaskTransition(taskStatusSchema.parse(task.status), to);
      } catch (error) {
        if (!(error instanceof InvalidTaskTransitionError)) throw error;
        await tx.auditEvent.create({ data: { id: randomUUID(), projectId: task.projectId, taskId: task.id, actor: approver, action: "TASK_INVALID_TRANSITION_ATTEMPT", riskLevel: "REVIEW", detailsJson: canonicalJson({ from: task.status, to }) } });
        return { invalid: error } as const;
      }
      const approval = task.approvals.find(item => item.status === "PENDING" && item.specHash === task.specHash);
      if (!approval) throw new RelayV2ConflictError("No current approval request matches this task specification.");
      const normalized = JSON.parse(task.normalizedSpecJson) as NormalizedTaskSpec;
      const snapshot = approvalSnapshot(normalized, task.specHash);
      const now = new Date();
      const approved = await tx.approval.update({
        where: { id: approval.id },
        data: {
          status: "APPROVED",
          resolvedBy: approver,
          resolvedAt: now,
          approvedSpecJson: snapshot,
          executor: task.selectedExecutor,
          model: task.selectedModel,
          effort: task.selectedEffort,
          reviewer: task.reviewer,
          permissionsJson: canonicalJson(task.permissions.map(item => ({ permission: item.permission, value: JSON.parse(item.valueJson) as unknown })))
        }
      });
      const updated = await tx.task.update({ where: { id: task.id }, data: { status: "APPROVED", approvedAt: now } });
      await tx.auditEvent.create({ data: { id: randomUUID(), projectId: task.projectId, taskId: task.id, actor: approver, action: "TASK_APPROVED", riskLevel: "REVIEW", detailsJson: canonicalJson({ approvalId: approved.id, specHash: task.specHash, executor: approved.executor, model: approved.model, effort: approved.effort, reviewer: approved.reviewer }) } });
      return { invalid: null, task: updated, approval: approved } as const;
    });
    if (outcome.invalid) throw outcome.invalid;
    return outcome;
  }

  async replaceTaskSpec(taskId: string, normalized: NormalizedTaskSpec, actor = "local-user") {
    const checked = normalizedTaskSpecSchema.parse(normalized);
    const nextHash = hashTaskSpec(checked);
    const outcome = await this.database.$transaction(async tx => {
      const task = await tx.task.findUnique({ where: { id: taskId }, include: { project: true } });
      if (!task) throw new RelayV2NotFoundError("Task not found.");
      if (task.project.name.toLocaleLowerCase("en-US") !== checked.project.name.toLocaleLowerCase("en-US")) {
        throw new RelayV2ConflictError(`The edited specification names project '${checked.project.name}', not '${task.project.name}'.`);
      }
      const currentStatus = taskStatusSchema.parse(task.status);
      if (currentStatus !== "PENDING_APPROVAL" && currentStatus !== "APPROVED") {
        const target: TaskStatus = "PENDING_APPROVAL";
        await tx.auditEvent.create({ data: { id: randomUUID(), projectId: task.projectId, taskId: task.id, actor, action: "TASK_INVALID_TRANSITION_ATTEMPT", riskLevel: "REVIEW", detailsJson: canonicalJson({ from: currentStatus, to: target, reason: "spec-edit" }) } });
        return { invalid: new InvalidTaskTransitionError(currentStatus, target) } as const;
      }
      if (task.specHash === nextHash) return { unchanged: true, task } as const;
      if (currentStatus === "APPROVED") assertTaskTransition("APPROVED", "PENDING_APPROVAL");
      const now = new Date();
      await tx.approval.updateMany({ where: { taskId: task.id, status: { in: ["PENDING", "APPROVED"] } }, data: { status: "INVALIDATED", invalidatedAt: now } });
      await Promise.all([
        tx.taskConstraint.deleteMany({ where: { taskId: task.id } }),
        tx.acceptanceCriterion.deleteMany({ where: { taskId: task.id } }),
        tx.taskPermission.deleteMany({ where: { taskId: task.id } })
      ]);
      const updated = await tx.task.update({
        where: { id: task.id },
        data: {
          title: checked.task.title,
          objective: checked.task.objective,
          taskType: checked.task.taskType,
          complexity: checked.task.complexity,
          status: "PENDING_APPROVAL",
          context: checked.task.context,
          suggestedExecutor: checked.execution.executor,
          suggestedModel: checked.execution.model,
          suggestedEffort: checked.execution.effort,
          selectedExecutor: checked.execution.executor,
          selectedModel: checked.execution.model,
          selectedEffort: checked.execution.effort,
          reviewer: checked.execution.reviewer,
          specVersion: { increment: 1 },
          specHash: nextHash,
          normalizedSpecJson: canonicalJson(checked),
          approvedAt: null,
          constraints: { create: checked.constraints.map((text, ordinal) => ({ id: randomUUID(), ordinal, text })) },
          acceptanceCriteria: { create: checked.acceptanceCriteria.map((description, ordinal) => ({ id: randomUUID(), ordinal, description })) },
          permissions: { create: checked.permissions.map((permission, ordinal) => ({ id: randomUUID(), ordinal, permission: permission.permission, valueJson: canonicalJson(permission.value) })) }
        }
      });
      await tx.approval.create({ data: { id: randomUUID(), taskId: task.id, approvalType: "TASK_EXECUTION", requestedBy: actor, status: "PENDING", specHash: nextHash, approvedSpecJson: approvalSnapshot(checked, nextHash), executor: checked.execution.executor, model: checked.execution.model, effort: checked.execution.effort, reviewer: checked.execution.reviewer, permissionsJson: permissionJson(checked) } });
      await tx.auditEvent.createMany({ data: [
        { id: randomUUID(), projectId: task.projectId, taskId: task.id, actor, action: "TASK_APPROVAL_INVALIDATED", riskLevel: "REVIEW", detailsJson: canonicalJson({ previousSpecHash: task.specHash, nextSpecHash: nextHash }) },
        { id: randomUUID(), projectId: task.projectId, taskId: task.id, actor, action: "TASK_SUBMITTED_FOR_APPROVAL", riskLevel: "REVIEW", detailsJson: canonicalJson({ from: currentStatus, to: "PENDING_APPROVAL", specHash: nextHash }) }
      ] });
      return { unchanged: false, task: updated } as const;
    });
    if ("invalid" in outcome) throw outcome.invalid;
    return outcome;
  }

  async cancelTask(taskId: string, actor: string, rejected = false) {
    const outcome = await this.database.$transaction(async tx => {
      const task = await tx.task.findUnique({ where: { id: taskId } });
      if (!task) throw new RelayV2NotFoundError("Task not found.");
      const from = taskStatusSchema.parse(task.status);
      try {
        assertTaskTransition(from, "CANCELLED");
      } catch (error) {
        if (!(error instanceof InvalidTaskTransitionError)) throw error;
        await tx.auditEvent.create({ data: { id: randomUUID(), projectId: task.projectId, taskId: task.id, actor, action: "TASK_INVALID_TRANSITION_ATTEMPT", riskLevel: "REVIEW", detailsJson: canonicalJson({ from, to: "CANCELLED" }) } });
        return { invalid: error } as const;
      }
      const now = new Date();
      const updated = await tx.task.update({ where: { id: task.id }, data: { status: "CANCELLED", cancelledAt: now } });
      await tx.approval.updateMany({ where: { taskId: task.id, status: "PENDING" }, data: { status: "REJECTED", resolvedBy: actor, resolvedAt: now } });
      await tx.auditEvent.create({ data: { id: randomUUID(), projectId: task.projectId, taskId: task.id, actor, action: rejected ? "TASK_REJECTED" : "TASK_CANCELLED", riskLevel: "REVIEW", detailsJson: canonicalJson({ from, to: "CANCELLED" }) } });
      return { invalid: null, task: updated } as const;
    });
    if (outcome.invalid) throw outcome.invalid;
    return outcome.task;
  }
}
