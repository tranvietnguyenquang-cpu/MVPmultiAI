import {
  executorDescriptorSchema,
  executorEventSchema,
  executionPolicyFromPermissions,
  type ExecutorDescriptor,
  type ExecutorEvent
} from "@project-relay/relay-v2-domain";
import type { CodexCapabilitySnapshot } from "./codex-capabilities.js";
import { CodexCapabilityDiscovery } from "./codex-capabilities.js";
import type {
  ExecutionContext, ExecutionControls, ExecutorHealth, ExecutorValidationRequest, ExecutorValidationResult,
  PreparedExecution, RelayExecutor
} from "./executor-contract.js";
import { renderCodexPrompt } from "./execution-capsule.js";
import { SafeProcessRunner, type ProcessRunner } from "./process-runner.js";

export interface CodexCapabilityProvider { discover(): Promise<CodexCapabilitySnapshot>; }

export type CodexCliExecutorOptions = {
  discovery?: CodexCapabilityProvider;
  runner?: ProcessRunner;
  supportedModels?: readonly string[];
  supportedEfforts?: Readonly<Record<string, readonly string[]>>;
  capabilityFreshnessMs?: number;
  now?: () => Date;
};

export function buildCodexArgv(input: {
  workspacePath: string;
  model: string;
  effort: string;
  capabilities: CodexCapabilitySnapshot;
  supportedModels: readonly string[];
  supportedEfforts: Readonly<Record<string, readonly string[]>>;
}): string[] {
  const args = ["-a", "never", "exec", "--ephemeral", "--ignore-user-config", "--color", "never", "--json", "-s", "workspace-write", "-C", input.workspacePath];
  if (input.model !== "AUTO") {
    if (!input.capabilities.modelFlag || !input.supportedModels.includes(input.model)) throw new Error(`Model '${input.model}' is not in the verified local Codex catalog.`);
    args.push("--model", input.model);
  }
  if (input.effort !== "AUTO") {
    const configArgs = input.supportedEfforts[input.effort];
    if (!configArgs) throw new Error(`Reasoning effort '${input.effort}' is not supported by the verified Codex capability snapshot.`);
    args.push(...configArgs);
  }
  args.push("-");
  return args;
}

export class CodexCliExecutor implements RelayExecutor {
  readonly id = "codex-cli";
  private readonly discovery: CodexCapabilityProvider;
  private readonly runner: ProcessRunner;
  private readonly supportedModels: readonly string[];
  private readonly supportedEfforts: Readonly<Record<string, readonly string[]>>;
  private snapshot?: CodexCapabilitySnapshot;
  private readonly capabilityFreshnessMs: number;
  private readonly now: () => Date;

  constructor(options: CodexCliExecutorOptions = {}) {
    this.discovery = options.discovery ?? new CodexCapabilityDiscovery();
    this.runner = options.runner ?? new SafeProcessRunner();
    this.supportedModels = options.supportedModels ?? [];
    this.supportedEfforts = options.supportedEfforts ?? {};
    this.capabilityFreshnessMs = options.capabilityFreshnessMs ?? 30_000;
    this.now = options.now ?? (() => new Date());
  }

  describe(): ExecutorDescriptor {
    return executorDescriptorSchema.parse({
      id: this.id,
      displayName: "Codex CLI",
      capabilities: ["non-interactive-exec", "jsonl-output", "workspace-write-sandbox", "stdin-capsule"],
      supportedModes: ["local-cli"],
      supportsCancellation: true,
      supportsTimeout: true,
      writeCapability: true,
      providerType: "LOCAL_CLI"
    });
  }

  async refreshCapabilities(): Promise<CodexCapabilitySnapshot> {
    this.snapshot = await this.discovery.discover();
    return this.snapshot;
  }

  async capabilities(): Promise<CodexCapabilitySnapshot> {
    if (!this.snapshot) return this.refreshCapabilities();
    const age = this.now().getTime() - new Date(this.snapshot.detectedAt).getTime();
    return age >= 0 && age <= this.capabilityFreshnessMs ? this.snapshot : this.refreshCapabilities();
  }

  async validate(request: ExecutorValidationRequest): Promise<ExecutorValidationResult> {
    if (request.approvedExecutor !== "CODEX") return { valid: false, reason: "The approved executor is not Codex CLI." };
    const policy = executionPolicyFromPermissions(request.approvedPermissions);
    if (!policy.workspaceWrite) return { valid: false, reason: "Codex CLI requires approved workspace-write permission." };
    if (!policy.nonProductionConfirmed) return { valid: false, reason: "Codex CLI requires confirmation that the target is non-production." };
    // Login state can change after a persisted/manual diagnostic. Revalidate at execution authority time.
    const snapshot = await this.refreshCapabilities();
    if (!snapshot.supported) return { valid: false, reason: snapshot.unsupportedReasons.join(" ") || "Codex CLI capabilities are unsupported." };
    if (snapshot.authenticationStatus !== "AUTHENTICATED") return { valid: false, reason: snapshot.authenticationStatus === "UNAUTHENTICATED" ? "Codex CLI is installed but not logged in." : "Codex CLI authentication could not be verified." };
    try {
      buildCodexArgv({
        workspacePath: request.workspacePath,
        model: request.approvedModel,
        effort: request.approvedEffort,
        capabilities: snapshot,
        supportedModels: this.supportedModels,
        supportedEfforts: this.supportedEfforts
      });
      return { valid: true };
    } catch (error) {
      return { valid: false, reason: error instanceof Error ? error.message : "Codex CLI configuration is unsupported." };
    }
  }

  async prepare(context: ExecutionContext): Promise<PreparedExecution> {
    if (!context.capsule) throw new Error("Codex execution requires an immutable execution capsule.");
    const snapshot = await this.capabilities();
    if (!snapshot.executablePath) throw new Error("Codex CLI executable is unavailable.");
    return {
      executionId: context.sessionId,
      context,
      executablePath: snapshot.executablePath,
      argv: buildCodexArgv({
        workspacePath: context.workspacePath,
        model: context.approvedModel,
        effort: context.approvedEffort,
        capabilities: snapshot,
        supportedModels: this.supportedModels,
        supportedEfforts: this.supportedEfforts
      }),
      stdin: renderCodexPrompt(context.capsule)
    };
  }

  async *execute(prepared: PreparedExecution, controls: ExecutionControls): AsyncIterable<ExecutorEvent> {
    if (!prepared.executablePath || !prepared.argv || prepared.stdin === undefined) throw new Error("Codex execution was not prepared safely.");
    for await (const event of this.runner.run({
      executionId: prepared.executionId,
      executablePath: prepared.executablePath,
      args: prepared.argv,
      cwd: prepared.context.workspacePath,
      stdin: prepared.stdin,
      timeoutMs: prepared.context.timeoutMs,
      maxOutputBytes: 5 * 1024 * 1024
    }, controls.signal)) {
      if (event.type === "started") {
        yield executorEventSchema.parse({ type: "process", message: "Codex CLI process started.", payload: event.ownership });
      } else if (event.type === "stdout" || event.type === "stderr") {
        yield executorEventSchema.parse({ type: "output", message: event.message, payload: { stream: event.type } });
      } else if (event.type === "warning") {
        yield executorEventSchema.parse({ type: "warning", message: event.message, payload: {} });
      } else if (event.type === "exit") {
        const result = event.result;
        const success = result.exitCode === 0 && !result.timedOut && !result.cancelled;
        yield executorEventSchema.parse({
          type: "result",
          message: success ? "Codex CLI exited successfully; Relay verification is pending." : `Codex CLI exited with code ${result.exitCode ?? "unknown"}.`,
          payload: {
            success,
            exitCode: result.exitCode,
            signal: result.signal,
            timedOut: result.timedOut,
            cancelled: result.cancelled,
            failureCode: result.timedOut ? "TIMEOUT" : result.cancelled ? "CANCELLED" : success ? undefined : "CODEX_EXIT_NONZERO"
          }
        });
      }
    }
  }

  async cancel(executionId: string): Promise<void> { await this.runner.cancel(executionId); }
  async cleanup(): Promise<void> {}
  async health(): Promise<ExecutorHealth> {
    const snapshot = await this.capabilities();
    return {
      healthy: snapshot.supported && snapshot.authenticationStatus === "AUTHENTICATED",
      checkedAt: snapshot.detectedAt,
      message: snapshot.authenticationStatus === "UNAUTHENTICATED"
        ? `Codex CLI ${snapshot.version || "unknown"} is installed but not logged in.`
        : snapshot.supported ? `Codex CLI ${snapshot.version} is ready.` : snapshot.unsupportedReasons.join(" ")
    };
  }
}
