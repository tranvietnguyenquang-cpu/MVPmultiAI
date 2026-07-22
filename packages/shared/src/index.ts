import { z } from "zod";

export const commandSpecSchema = z.object({
  id: z.string().regex(/^[a-z0-9:_-]+$/),
  label: z.string().min(1).max(80),
  executable: z.string().min(1).max(260),
  args: z.array(z.string().max(500)).max(30),
  category: z.enum(["safe", "destructive"]).default("safe"),
  evidenceKind: z.enum(["TYPECHECK", "LINT", "UNIT_TEST", "INTEGRATION_TEST", "BUILD", "MIGRATION", "COMMAND"]).default("COMMAND"),
  timeoutMs: z.number().int().min(1_000).max(3_600_000).default(600_000)
});
export type CommandSpec = z.infer<typeof commandSpecSchema>;

export const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(100),
  repositoryPath: z.string().trim().min(3).max(1024),
  commands: z.array(commandSpecSchema).max(30).default([])
});

export const createTaskSchema = z.object({
  projectId: z.string().min(1),
  title: z.string().trim().min(1).max(160),
  userRequest: z.string().trim().min(1).max(20_000),
  objective: z.string().trim().min(1).max(2_000),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).default("MEDIUM"),
  relevantFiles: z.array(z.string().max(1024)).max(100).default([]),
  constraints: z.array(z.string().max(1_000)).max(100).default([]),
  prohibitedChanges: z.array(z.string().max(1_000)).max(100).default([]),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(1_000)).min(1).max(50),
  assignedProvider: z.string().default("codex")
});

export type TaskCapsuleContent = {
  task: { id: string; title: string; objective: string; userRequest: string };
  architectureDecisions: Array<{ id: string; title: string; decision: string; locked: boolean }>;
  codingRules: string;
  sourceContext: Array<{ path: string; summary: string }>;
  knownIssues: string;
  acceptanceCriteria: Array<{ id: string; description: string }>;
  latestTestEvidence: Array<{ kind: string; successful: boolean; summary: string }>;
  prohibitedChanges: string[];
};

export const sessionJobSchema = z.object({ sessionId: z.string(), taskId: z.string(), capsuleId: z.string() });
export type SessionJob = z.infer<typeof sessionJobSchema>;

export function approximateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}

export function canVerify(criteria: Array<{ evidence: Array<{ successful: boolean }> }>): boolean {
  return criteria.length > 0 && criteria.every((criterion) => criterion.evidence.some((item) => item.successful));
}
