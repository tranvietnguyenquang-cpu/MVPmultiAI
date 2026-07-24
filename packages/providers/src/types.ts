import type { TaskCapsuleContent } from "@project-relay/shared";
import type { UsageReport } from "./stream-parser.js";

export type ProviderId = "codex-cli" | "claude-cli";
export type ProviderRole = "IMPLEMENTER" | "REVIEWER" | "VERIFIER";
export type ProviderAuthentication =
  | "AUTHENTICATED"
  | "NOT_AUTHENTICATED"
  | "RATE_LIMITED"
  | "NETWORK_ERROR"
  | "CLI_ERROR"
  | "UNKNOWN";
export type QuotaSource =
  | "CLI_STATUS"
  | "PROVIDER_RESPONSE"
  | "LOCAL_ESTIMATE"
  | "USER_INPUT"
  | "OFFICIAL_API";
export type ExecutionCapability = "READ_ONLY" | "WORKSPACE_WRITE";

/** Server-only runtime data captured from the spawned child and operating system. */
export type ProviderProcessStart = {
  pid: number;
  processStartIdentity: string;
  processStartedAt: Date;
};

export type ProviderProcessLifecycle = {
  captureProcessStart(pid: number): Promise<ProviderProcessStart>;
  onProcessStarted(start: ProviderProcessStart): Promise<void>;
  onProcessStartFailure(input: {
    pid: number;
    start?: ProviderProcessStart;
    error: unknown;
  }): Promise<void>;
};

export type ProviderProbe = {
  providerId: ProviderId;
  installed: boolean;
  version?: string;
  authentication: ProviderAuthentication;
  available: boolean;
  latencyMs?: number;
  checkedAt: Date;
  resetAt?: Date;
  remainingPercent?: number;
  quotaSource: QuotaSource;
  quotaConfidence: "LOW" | "MEDIUM" | "HIGH";
  quotaExact: boolean;
  markerObserved?: boolean;
  exitCode?: number | null;
};

export type AgentSessionInput = {
  workspace: string;
  taskId: string;
  capability: ExecutionCapability;
  role?: ProviderRole;
  resumeExternalId?: string;
  /**
   * Explicit model id/alias to pass to the CLI (e.g. "sonnet", "o3"). Absent means
   * "Default": no --model flag is passed at all. Always the server-resolved value from
   * the model registry (see @project-relay/shared getModelDefinition/isModelSupported) -
   * never a raw, unvalidated browser string.
   */
  model?: string;
  /** Passed only through each provider's own supported configuration mechanism (Claude: --effort; Codex: -c model_reasoning_effort=). */
  reasoningEffort?: string;
  /** Worker-internal only; never populated from browser input or provider prompts. */
  processLifecycle?: ProviderProcessLifecycle;
};

export type AgentSession = {
  id: string;
  providerId: ProviderId;
  workspace: string;
  taskId: string;
  role: ProviderRole;
  capability: ExecutionCapability;
  model?: string;
  reasoningEffort?: string;
  /**
   * The model the CLI's own structured stream actually reported using, once observed
   * (see stream-parser.ts). Mutated in place as the run's `runSession` consumes the
   * stream, mirroring how `externalId` is populated - stays undefined if the CLI never
   * reports one.
   */
  resolvedModel?: string;
  externalId?: string;
  /** In-memory worker hook; it is intentionally never serialized to provider output. */
  processLifecycle?: ProviderProcessLifecycle;
};

/** Result of a safe, harmless model-validation probe. Never fabricated: AVAILABLE is only ever reported when the CLI's own output actually confirms the model responded successfully. */
export type ModelAvailability = "AVAILABLE" | "UNSUPPORTED" | "NOT_AUTHENTICATED" | "RATE_LIMITED" | "NETWORK_ERROR" | "UNKNOWN";
export type ModelProbe = {
  providerId: ProviderId;
  modelId: string;
  reasoningEffort?: string;
  status: ModelAvailability;
  reason?: string;
  checkedAt: Date;
};

export type AgentEvent = {
  type: "state" | "stdout" | "stderr" | "usage";
  message: string;
  timestamp: Date;
};

export type ConnectionTest = {
  ok: boolean;
  output: string;
  durationMs: number;
  probe: ProviderProbe;
  markerObserved: boolean;
  exitCode: number | null;
};

export interface CodingProvider {
  readonly id: ProviderId;
  readonly name: string;
  readonly defaultRoles: ProviderRole[];
  readonly setupInstructions: string;

  detectInstallation(): Promise<boolean>;
  getVersion(): Promise<string | undefined>;
  refreshHealth(): Promise<ProviderProbe>;
  probeAuthentication(signal?: AbortSignal): Promise<ProviderProbe>;
  testConnection(signal?: AbortSignal): Promise<ConnectionTest>;
  /**
   * Safe, harmless validation probe for a specific model: uses the same production
   * executable resolver and SAFE_ENVIRONMENT as every other invocation, runs read-only
   * with a short timeout, never modifies the repository, and never reads credentials
   * beyond what the CLI's own auth already grants it.
   */
  probeModel(modelId: string, reasoningEffort?: string, signal?: AbortSignal): Promise<ModelProbe>;
  createSession(input: AgentSessionInput): Promise<AgentSession>;
  startSession(session: AgentSession, capsule: TaskCapsuleContent, signal?: AbortSignal): Promise<void>;
  sendTask(session: AgentSession, capsule: TaskCapsuleContent, signal?: AbortSignal): Promise<void>;
  streamEvents(sessionId: string): AsyncIterable<AgentEvent>;
  cancelSession(sessionId: string): Promise<void>;
  resumeSession(session: AgentSession, capsule: TaskCapsuleContent, signal?: AbortSignal): Promise<void>;
  getUsage(sessionId: string): Promise<UsageReport>;
}
