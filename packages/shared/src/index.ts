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

export const createConversationSchema = z.object({
  title: z.string().trim().min(1).max(200)
});

export const createConversationMessageSchema = z.object({
  content: z.string().trim().min(1).max(20_000),
  provider: z.enum(["codex-cli", "claude-cli", "auto"]),
  mode: z.enum(["ASK", "IMPLEMENT", "REVIEW", "CONTINUE", "VERIFY"]),
  taskId: z.string().min(1).optional(),
  idempotencyKey: z.string().trim().min(1).max(200).optional()
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

type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type TaskCapsuleContent = {
  task: { id: string; title: string; objective: string; userRequest: string };
  architectureDecisions: Array<{ id: string; title: string; decision: string; locked: boolean }>;
  codingRules: string;
  sourceContext: Array<{ path: string; summary: string }>;
  knownIssues: string;
  acceptanceCriteria: Array<{ id: string; description: string }>;
  latestTestEvidence: Array<{ kind: string; successful: boolean; summary: string }>;
  prohibitedChanges: string[];
  conversationMode?: "ASK" | "IMPLEMENT" | "REVIEW" | "CONTINUE" | "VERIFY";
  handoff?: { fromProviderId: string; toProviderId: string; objective: string; unresolvedIssues: JsonValue; acceptedFindings: JsonValue };
};

export type ConversationModeValue = "ASK" | "IMPLEMENT" | "REVIEW" | "CONTINUE" | "VERIFY";
export type ExecutionCapability = "READ_ONLY" | "WORKSPACE_WRITE";

/**
 * The authoritative provider/mode capability matrix. Only IMPLEMENT ever grants
 * workspace-write, and only Codex supports it: Claude has no safe workspace-write
 * sandbox in this build, so Claude+IMPLEMENT is absent (unsupported) rather than
 * silently downgraded. Every other combination is read-only at the CLI layer.
 */
const PROVIDER_MODE_CAPABILITY: Record<"codex-cli" | "claude-cli", Partial<Record<ConversationModeValue, ExecutionCapability>>> = {
  "codex-cli": { ASK: "READ_ONLY", REVIEW: "READ_ONLY", VERIFY: "READ_ONLY", CONTINUE: "READ_ONLY", IMPLEMENT: "WORKSPACE_WRITE" },
  "claude-cli": { ASK: "READ_ONLY", REVIEW: "READ_ONLY", VERIFY: "READ_ONLY", CONTINUE: "READ_ONLY" }
};

/** Returns null for a provider/mode combination that must be rejected before queueing. */
export function getProviderModeCapability(providerId: string, mode: string): ExecutionCapability | null {
  return PROVIDER_MODE_CAPABILITY[providerId as "codex-cli" | "claude-cli"]?.[mode as ConversationModeValue] ?? null;
}

export function listProviderModeCapabilities(): Array<{ providerId: "codex-cli" | "claude-cli"; mode: ConversationModeValue; capability: ExecutionCapability | null }> {
  const providers = ["codex-cli", "claude-cli"] as const;
  const modes = ["ASK", "IMPLEMENT", "REVIEW", "CONTINUE", "VERIFY"] as const;
  return providers.flatMap(providerId => modes.map(mode => ({ providerId, mode, capability: getProviderModeCapability(providerId, mode) })));
}

export const sessionJobSchema = z.object({ sessionId: z.string(), taskId: z.string(), capsuleId: z.string() });
export type SessionJob = z.infer<typeof sessionJobSchema>;

export const conversationMessageJobSchema = z.object({
  sessionId: z.string(),
  taskId: z.string(),
  conversationId: z.string(),
  messageId: z.string(),
  providerId: z.string(),
  routingDecisionId: z.string(),
  providerSessionId: z.string(),
  handoffCapsuleId: z.string().optional()
});
export type ConversationMessageJob = z.infer<typeof conversationMessageJobSchema>;

export function approximateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}

export function canVerify(criteria: Array<{ evidence: Array<{ successful: boolean }> }>): boolean {
  return criteria.length > 0 && criteria.every((criterion) => criterion.evidence.some((item) => item.successful));
}
export function criterionAcceptsEvidence(criterion:{evidenceKinds:string[];commandIds:string[]},evidence:{kind:string;commandId?:string}):boolean{return criterion.evidenceKinds.includes(evidence.kind)&&(!criterion.commandIds.length||Boolean(evidence.commandId&&criterion.commandIds.includes(evidence.commandId)));}
export function compactReviewCapsule(capsule:TaskCapsuleContent):TaskCapsuleContent{return{...capsule,codingRules:capsule.codingRules.slice(0,4_000),knownIssues:capsule.knownIssues.slice(0,4_000),sourceContext:capsule.sourceContext.slice(0,10).map(item=>({...item,summary:item.summary.slice(0,2_000)})),latestTestEvidence:capsule.latestTestEvidence.slice(0,20).map(item=>({...item,summary:item.summary.slice(0,2_000)}))};}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "").replace(/^::ffff:/, "");
  if (!normalized) return false;
  if (normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized);
}

export function assertLoopbackHost(host: string, context: string): void {
  if (!isLoopbackHost(host)) {
    throw new Error(`${context} must be loopback-only for this local-first build; refusing host '${host}'.`);
  }
}

/**
 * Next.js's own server injects x-forwarded-for/x-forwarded-host on every request that
 * reaches middleware - including a direct loopback connection with no real reverse proxy
 * involved - so their mere presence can't be treated as "this came through a proxy, reject
 * it". Instead, whenever present they must themselves resolve to loopback: a genuine
 * reverse-proxied exposure to a remote client reveals a non-loopback address in one of
 * these headers, which this still rejects.
 */
export function isLoopbackRequestHeaders(input: { host: string | null; forwardedFor: string | null; forwardedHost: string | null }): boolean {
  if (!input.host) return false;
  const hostname = input.host.split(":")[0] ?? "";
  if (!isLoopbackHost(hostname)) return false;
  if (input.forwardedFor) {
    const originClient = input.forwardedFor.split(",")[0]?.trim() ?? "";
    if (!isLoopbackHost(originClient)) return false;
  }
  if (input.forwardedHost) {
    const forwardedHostname = input.forwardedHost.split(":")[0] ?? "";
    if (!isLoopbackHost(forwardedHostname)) return false;
  }
  return true;
}

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
