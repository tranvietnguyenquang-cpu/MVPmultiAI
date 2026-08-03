import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson, type NormalizedTaskSpec, type TaskPermissionValue, verificationOperationSchema } from "@project-relay/relay-v2-domain";
import type { GitEvidence } from "./workspace-evidence.js";

export const executionCapsuleSchema = z.object({
  version: z.literal(1),
  sessionId: z.string().uuid(),
  taskId: z.string().uuid(),
  projectId: z.string().uuid(),
  taskTitle: z.string(),
  objective: z.string(),
  context: z.string(),
  constraints: z.array(z.string()),
  acceptanceCriteria: z.array(z.string()),
  selectedExecutor: z.literal("CODEX"),
  selectedModel: z.string(),
  selectedEffort: z.string(),
  reviewer: z.string(),
  approvedPermissions: z.array(z.object({ permission: z.string(), value: z.unknown() })),
  workspacePath: z.string(),
  gitBranch: z.string(),
  baselineCommit: z.string(),
  baselineStatus: z.array(z.object({ path: z.string(), indexStatus: z.string(), worktreeStatus: z.string(), sensitive: z.boolean() })),
  baselineEvidenceHash: z.string(),
  allowedOperationPolicy: z.array(z.string()),
  forbiddenOperations: z.array(z.string()),
  expectedVerificationOperations: z.array(verificationOperationSchema),
  timeoutSeconds: z.number().int().min(60).max(7_200),
  artifactDirectory: z.string(),
  createdAt: z.string().datetime(),
  capsuleHash: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();
export type ExecutionCapsule = z.infer<typeof executionCapsuleSchema>;

export function buildExecutionCapsule(input: {
  sessionId: string;
  taskId: string;
  projectId: string;
  spec: NormalizedTaskSpec;
  permissions: TaskPermissionValue[];
  workspacePath: string;
  baseline: GitEvidence;
  timeoutSeconds: number;
  verificationOperations: Array<z.infer<typeof verificationOperationSchema>>;
  artifactDirectory: string;
  createdAt?: Date;
}): ExecutionCapsule {
  const capsuleWithoutHash = {
    version: 1 as const,
    sessionId: input.sessionId,
    taskId: input.taskId,
    projectId: input.projectId,
    taskTitle: input.spec.task.title,
    objective: input.spec.task.objective,
    context: input.spec.task.context,
    constraints: input.spec.constraints,
    acceptanceCriteria: input.spec.acceptanceCriteria,
    selectedExecutor: "CODEX" as const,
    selectedModel: input.spec.execution.model,
    selectedEffort: input.spec.execution.effort,
    reviewer: input.spec.execution.reviewer,
    approvedPermissions: input.permissions,
    workspacePath: input.workspacePath,
    gitBranch: input.baseline.branch,
    baselineCommit: input.baseline.head,
    baselineStatus: input.baseline.status.map(item => ({
      path: item.path, indexStatus: item.indexStatus, worktreeStatus: item.worktreeStatus, sensitive: item.sensitive
    })),
    baselineEvidenceHash: input.baseline.evidenceHash,
    allowedOperationPolicy: [
      "Modify files only inside the approved workspace.",
      "Run repository-local, non-production development commands needed for the approved task.",
      "Run only the verification operations listed in this capsule as Relay-authoritative checks."
    ],
    forbiddenOperations: [
      "Do not access or modify production systems.",
      "Do not deploy, merge, push, commit, stash, checkout, reset, or force any Git operation.",
      "Do not read, print, copy, or reveal credentials, environment files, tokens, private keys, or database dumps.",
      "Do not operate outside the approved workspace.",
      "Do not weaken security controls or use danger-full-access."
    ],
    expectedVerificationOperations: input.verificationOperations,
    timeoutSeconds: input.timeoutSeconds,
    artifactDirectory: input.artifactDirectory,
    createdAt: (input.createdAt ?? new Date()).toISOString()
  };
  return executionCapsuleSchema.parse({
    ...capsuleWithoutHash,
    capsuleHash: createHash("sha256").update(canonicalJson(capsuleWithoutHash)).digest("hex")
  });
}

export function renderCodexPrompt(capsule: ExecutionCapsule): string {
  return `You are executing one approved Relay task. The immutable execution capsule follows.\n\n${JSON.stringify(capsule, null, 2)}\n\n` +
    "Operate only inside workspacePath. Do not access production, deploy, commit, push, merge, stash, checkout, reset, or force Git operations. " +
    "Do not read or reveal secrets or environment files. Run relevant local tests, but Relay alone decides whether approved verification passed. " +
    "If an assumption or requested option is unsupported, report it clearly and stop safely.";
}
