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
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
  /**
   * Raw browser-supplied model id/alias, or omitted for "Default". This is bounded to a
   * plausible length here but is NEVER trusted as a real CLI flag on its own: the server
   * always re-validates it against MODEL_REGISTRY (see getModelDefinition/isModelSupported
   * below) before it can influence a spawned process, and it only ever becomes a single
   * argv array element - never shell-concatenated - so it cannot inject additional flags
   * even if validation were somehow bypassed.
   */
  model: z.string().trim().min(1).max(200).optional(),
  reasoningEffort: z.string().trim().min(1).max(50).optional()
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
 * workspace-write. Codex uses its own OS-level sandbox for this; Claude uses its
 * own tool-permission allowlist (see claude-cli-provider.ts) - never an unrestricted
 * permission bypass. Every other combination is read-only at the CLI layer.
 *
 * CONTINUE is intentionally READ_ONLY here: this matrix is the static per-mode
 * default, used directly for Codex (whose CONTINUE behavior is unchanged) and as
 * the fallback for Claude when there is no prior execution to inherit from. Claude's
 * actual CONTINUE capability is resolved dynamically by resolveExecutionCapability
 * below, which inherits the capability of the execution being continued.
 */
const PROVIDER_MODE_CAPABILITY: Record<"codex-cli" | "claude-cli", Partial<Record<ConversationModeValue, ExecutionCapability>>> = {
  "codex-cli": { ASK: "READ_ONLY", REVIEW: "READ_ONLY", VERIFY: "READ_ONLY", CONTINUE: "READ_ONLY", IMPLEMENT: "WORKSPACE_WRITE" },
  "claude-cli": { ASK: "READ_ONLY", REVIEW: "READ_ONLY", VERIFY: "READ_ONLY", CONTINUE: "READ_ONLY", IMPLEMENT: "WORKSPACE_WRITE" }
};

/** Returns null for a provider/mode combination that must be rejected before queueing. */
export function getProviderModeCapability(providerId: string, mode: string): ExecutionCapability | null {
  return PROVIDER_MODE_CAPABILITY[providerId as "codex-cli" | "claude-cli"]?.[mode as ConversationModeValue] ?? null;
}

/**
 * Resolves the *effective* capability for a queued execution. Only Claude's CONTINUE
 * mode ever deviates from the static matrix above: it inherits the capability of the
 * execution being continued (e.g. continuing a Claude IMPLEMENT run stays
 * workspace-write; continuing a Claude ASK/REVIEW/VERIFY run stays read-only), falling
 * back to the matrix default (read-only) when there is nothing to continue. Codex's
 * CONTINUE behavior is deliberately unchanged: it always reads from the static matrix,
 * ignoring `continuedCapability`.
 */
export function resolveExecutionCapability(providerId: string, mode: string, continuedCapability?: ExecutionCapability | null): ExecutionCapability | null {
  if (providerId === "claude-cli" && mode === "CONTINUE") {
    return continuedCapability ?? getProviderModeCapability(providerId, mode);
  }
  return getProviderModeCapability(providerId, mode);
}

export function listProviderModeCapabilities(): Array<{ providerId: "codex-cli" | "claude-cli"; mode: ConversationModeValue; capability: ExecutionCapability | null }> {
  const providers = ["codex-cli", "claude-cli"] as const;
  const modes = ["ASK", "IMPLEMENT", "REVIEW", "CONTINUE", "VERIFY"] as const;
  return providers.flatMap(providerId => modes.map(mode => ({ providerId, mode, capability: getProviderModeCapability(providerId, mode) })));
}

/**
 * How an execution's model was determined, in priority order from most to least
 * specific. PROVIDER_DEFAULT means no override applied anywhere in the chain - the
 * CLI/account's own default model is used, and no --model flag is passed at all.
 */
export type ModelSource = "USER_SELECTED" | "PROJECT_DEFAULT" | "SYSTEM_DEFAULT" | "PROVIDER_DEFAULT";
export type ProviderId = "codex-cli" | "claude-cli";

export type ModelDefinition = {
  providerId: ProviderId;
  /** The exact string passed to the CLI's --model/-m flag. "Default" is never a registry entry - it is represented by the absence of a selection. */
  modelId: string;
  displayName: string;
  /** Whether this entry is offered as a selectable option at all. Independent of - and not a substitute for - the live ModelHealth probe, which reflects whether it actually works for *this* account right now. */
  enabled: boolean;
  supportedModes: ConversationModeValue[];
  /** Reasoning-effort values this model accepts, passed only through the provider's own supported configuration mechanism (Claude: --effort; Codex: -c model_reasoning_effort=). Empty means the reasoning-effort selector never shows for this model. */
  allowedReasoningEfforts: string[];
};

const ALL_MODES: ConversationModeValue[] = ["ASK", "IMPLEMENT", "REVIEW", "CONTINUE", "VERIFY"];
/** Documented Codex CLI `model_reasoning_effort` config values (see `codex exec -c model_reasoning_effort=<value>`). */
const CODEX_REASONING_EFFORTS = ["minimal", "low", "medium", "high"];

/**
 * The authoritative, server-controlled model registry (see also claude-cli-provider.ts /
 * codex-cli-provider.ts for how each entry's modelId becomes a CLI argument). Configured
 * here rather than accepted from the browser: a request naming a model absent from this
 * list is rejected before queueing (see isModelSupported), regardless of what string a
 * client sends. `enabled: true` means "offered as an option" - it is deliberately not a
 * claim that the model is available to every account; actual per-account availability is
 * determined separately by the ModelHealth validation probe.
 */
export const MODEL_REGISTRY: Record<ProviderId, ModelDefinition[]> = {
  "claude-cli": [
    { providerId: "claude-cli", modelId: "sonnet", displayName: "Claude Sonnet", enabled: true, supportedModes: ALL_MODES, allowedReasoningEfforts: [] },
    { providerId: "claude-cli", modelId: "opus", displayName: "Claude Opus", enabled: true, supportedModes: ALL_MODES, allowedReasoningEfforts: [] }
  ],
  "codex-cli": [
    { providerId: "codex-cli", modelId: "o3", displayName: "Codex o3", enabled: true, supportedModes: ALL_MODES, allowedReasoningEfforts: CODEX_REASONING_EFFORTS },
    { providerId: "codex-cli", modelId: "gpt-5-codex", displayName: "Codex (GPT-5-Codex)", enabled: true, supportedModes: ALL_MODES, allowedReasoningEfforts: CODEX_REASONING_EFFORTS }
  ]
};

/** Returns null for a model absent from the registry, disabled, or (when a mode is given) not supported in that mode. */
export function getModelDefinition(providerId: string, modelId: string): ModelDefinition | null {
  return (MODEL_REGISTRY[providerId as ProviderId] ?? []).find(entry => entry.modelId === modelId) ?? null;
}

export function listModelsForProvider(providerId: string): ModelDefinition[] {
  return MODEL_REGISTRY[providerId as ProviderId] ?? [];
}

/** "Default" (modelId null/undefined) is always supported; any other id must be an enabled registry entry that supports the requested mode. */
export function isModelSupported(providerId: string, modelId: string | null | undefined, mode?: string): boolean {
  if (!modelId) return true;
  const definition = getModelDefinition(providerId, modelId);
  if (!definition || !definition.enabled) return false;
  return !mode || definition.supportedModes.includes(mode as ConversationModeValue);
}

/** A model belongs to the provider that registered it; this rejects a modelId that happens to be valid for the *other* provider. */
export function modelBelongsToProvider(providerId: string, modelId: string): boolean {
  return getModelDefinition(providerId, modelId) !== null;
}

export function isReasoningEffortAllowed(providerId: string, modelId: string | null | undefined, effort: string | null | undefined): boolean {
  if (!effort) return true;
  if (!modelId) return false;
  const definition = getModelDefinition(providerId, modelId);
  return Boolean(definition?.allowedReasoningEfforts.includes(effort));
}

/**
 * Resolves the effective model for a queued execution through the documented priority
 * chain: explicit execution selection -> project default -> application default ->
 * provider CLI default (i.e. no override at all, model stays null). `explicit` should be
 * the browser's raw requested model (already schema-bounded, not yet registry-validated -
 * callers must still check isModelSupported/modelBelongsToProvider before trusting the
 * result for a spawn).
 */
export function resolveEffectiveModel(input: {
  explicit?: string | null | undefined;
  projectDefault?: string | null | undefined;
  applicationDefault?: string | null | undefined;
}): { model: string | null; modelSource: ModelSource } {
  if (input.explicit) return { model: input.explicit, modelSource: "USER_SELECTED" };
  if (input.projectDefault) return { model: input.projectDefault, modelSource: "PROJECT_DEFAULT" };
  if (input.applicationDefault) return { model: input.applicationDefault, modelSource: "SYSTEM_DEFAULT" };
  return { model: null, modelSource: "PROVIDER_DEFAULT" };
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

/**
 * Automated tests must never be able to mutate the real local-beta database/Redis (or any
 * other unrelated project's), even by accident. Both allowlists below are intentionally
 * positive-match only ("must look disposable") rather than a denylist of known-bad names:
 * a denylist has to be told about every real database it must protect, while an allowlist
 * refuses everything by default and only lets through what was explicitly provisioned for
 * throwaway test/verification use.
 */
const DISPOSABLE_DATABASE_NAME_PATTERN = /^projectrelay_(?:test|validation|e2e)_[a-z0-9_]+$/;

export function isDisposableDatabaseName(name: string): boolean {
  return DISPOSABLE_DATABASE_NAME_PATTERN.test(name.trim().toLowerCase());
}

/** Throws before any database mutation unless the URL is loopback-only and names an explicitly disposable database (e.g. `projectrelay_test_verification`). */
export function assertDisposableDatabaseUrl(rawUrl: string | undefined, context = "DATABASE_URL"): void {
  if (!rawUrl) throw new Error(`${context} is required and must point at a disposable test database (e.g. projectrelay_test_*).`);
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`${context} is not a valid connection string.`);
  }
  assertLoopbackHost(parsed.hostname, context);
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!isDisposableDatabaseName(databaseName)) {
    throw new Error(
      `Refusing to run automated tests against database '${databaseName}'. ${context} must name a disposable database matching projectrelay_test_*, projectrelay_validation_*, or projectrelay_e2e_* - never 'projectrelay' (local-beta), 'WebManageSchool', or any other non-disposable database.`
    );
  }
}

const DISPOSABLE_REDIS_PORTS = new Set(["56379"]);

/** Throws unless the URL is loopback-only and uses the dedicated disposable test Redis port - never the local-beta (6380) or any other project's (e.g. 6379) Redis. */
export function assertDisposableRedisUrl(rawUrl: string | undefined, context = "REDIS_URL"): void {
  if (!rawUrl) throw new Error(`${context} is required and must point at the disposable test Redis instance.`);
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`${context} is not a valid connection string.`);
  }
  assertLoopbackHost(parsed.hostname, context);
  const port = parsed.port || "6379";
  if (!DISPOSABLE_REDIS_PORTS.has(port)) {
    throw new Error(`Refusing to run automated tests against Redis port ${port}. ${context} must point at the dedicated disposable test Redis port (56379), never the local-beta or any other project's Redis.`);
  }
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
