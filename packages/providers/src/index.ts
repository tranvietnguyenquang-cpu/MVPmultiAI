import { ClaudeCliProvider } from "./claude-cli-provider.js";
import { CodexCliProvider } from "./codex-cli-provider.js";
import { ProviderRegistry } from "./registry.js";

export { ClaudeCliProvider } from "./claude-cli-provider.js";
export { CodexCliProvider } from "./codex-cli-provider.js";
export { classifyModelProbe, classifyProviderProbe } from "./process-runner.js";
export { ProviderRegistry } from "./registry.js";
export {
  ClaudeStreamParser,
  CodexStreamParser,
  IncrementalLineReader,
  StaleProviderSessionError,
  StructuredStreamAccumulator,
  isStaleProviderSessionSignal,
} from "./stream-parser.js";
export type {
  ParsedStreamEvent,
  StreamOutcome,
  StructuredStreamParser,
  UsageReport,
} from "./stream-parser.js";
export type {
  AgentEvent,
  AgentSession,
  AgentSessionInput,
  CodingProvider,
  ConnectionTest,
  ExecutionCapability,
  ModelAvailability,
  ModelProbe,
  ProviderAuthentication,
  ProviderId,
  ProviderProbe,
  ProviderProcessLifecycle,
  ProviderProcessStart,
  ProviderRole,
  QuotaSource,
} from "./types.js";

export const providerRegistry = new ProviderRegistry([
  new CodexCliProvider(),
  new ClaudeCliProvider(),
]);
