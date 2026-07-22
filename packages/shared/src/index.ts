import { z } from "zod";

export const commandSpecSchema = z.object({
  id: z.string().regex(/^[a-z0-9:_-]+$/),
  label: z.string().min(1).max(80),
  executable: z.enum(["git", "node", "npm", "npx"]),
  args: z.array(z.string().max(500)).max(30),
  category: z.enum(["safe", "destructive"]).default("safe"),
  evidenceKind: z.enum(["TYPECHECK", "LINT", "UNIT_TEST", "INTEGRATION_TEST", "BUILD", "MIGRATION", "COMMAND"]).default("COMMAND"),
  timeoutMs: z.number().int().min(1_000).max(3_600_000).default(600_000)
});
export type CommandSpec = z.infer<typeof commandSpecSchema>;

export const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(100),
  repositoryPath: z.string().trim().min(3).max(1024),
  commandIds: z.array(z.enum(["test", "typecheck", "lint", "build"])).max(4).default(["test","typecheck","build"])
});

export const acceptanceCriterionInputSchema = z.object({
  description: z.string().trim().min(1).max(1_000),
  evidenceKinds: z.array(z.enum(["CHANGED_FILES","GIT_DIFF","GIT_STATUS","TYPECHECK","LINT","UNIT_TEST","INTEGRATION_TEST","BUILD","MIGRATION","SCREENSHOT","ARTIFACT","COMMAND"])).min(1),
  commandIds: z.array(z.string().regex(/^[a-z0-9:_-]+$/)).default([])
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
  acceptanceCriteria: z.array(acceptanceCriterionInputSchema).min(1).max(50),
  assignedProvider: z.enum(["codex-cli", "claude-cli"]).default("codex-cli")
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
export function criterionAcceptsEvidence(criterion:{evidenceKinds:string[];commandIds:string[]},evidence:{kind:string;commandId?:string}):boolean{return criterion.evidenceKinds.includes(evidence.kind)&&(!criterion.commandIds.length||Boolean(evidence.commandId&&criterion.commandIds.includes(evidence.commandId)));}
export function compactReviewCapsule(capsule:TaskCapsuleContent):TaskCapsuleContent{return{...capsule,codingRules:capsule.codingRules.slice(0,4_000),knownIssues:capsule.knownIssues.slice(0,4_000),sourceContext:capsule.sourceContext.slice(0,10).map(item=>({...item,summary:item.summary.slice(0,2_000)})),latestTestEvidence:capsule.latestTestEvidence.slice(0,20).map(item=>({...item,summary:item.summary.slice(0,2_000)}))};}

export type LockedDecisionRule = { id: string; forbiddenPaths: string[]; requiredPatterns: string[] };
function globPattern(pattern: string): RegExp {
  const escaped=pattern.replace(/[.+^${}()|[\]\\]/g,"\\$&").replace(/\*\*/g,".*").replace(/\*/g,"[^/]*");
  return new RegExp(`^${escaped}$`,"i");
}
export function findLockedDecisionConflicts(rules: LockedDecisionRule[], paths: string[], diff = ""): string[] {
  const normalized=paths.map(item=>item.replace(/\\/g,"/"));
  return rules.flatMap(rule=>[
    ...rule.forbiddenPaths.flatMap(pattern=>normalized.some(file=>globPattern(pattern).test(file))?[`${rule.id}: forbidden path ${pattern}`]:[]),
    ...rule.requiredPatterns.flatMap(pattern=>diff && !diff.includes(pattern)?[`${rule.id}: required invariant '${pattern}' is absent from the diff`]:[])
  ]);
}
