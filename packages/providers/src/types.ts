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
};

export type AgentSession = {
  id: string;
  providerId: ProviderId;
  workspace: string;
  taskId: string;
  role: ProviderRole;
  capability: ExecutionCapability;
  externalId?: string;
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
  createSession(input: AgentSessionInput): Promise<AgentSession>;
  startSession(session: AgentSession, capsule: TaskCapsuleContent, signal?: AbortSignal): Promise<void>;
  sendTask(session: AgentSession, capsule: TaskCapsuleContent, signal?: AbortSignal): Promise<void>;
  streamEvents(sessionId: string): AsyncIterable<AgentEvent>;
  cancelSession(sessionId: string): Promise<void>;
  resumeSession(session: AgentSession, capsule: TaskCapsuleContent, signal?: AbortSignal): Promise<void>;
  getUsage(sessionId: string): Promise<UsageReport>;
}
