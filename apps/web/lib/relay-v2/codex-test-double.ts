import {
  CodexCliExecutor, type CodexCapabilitySnapshot, type ProcessRunRequest,
  type ProcessRunner, type ProcessRunnerEvent
} from "@project-relay/relay-v2-execution";

class BrowserCodexProcessDouble implements ProcessRunner {
  private readonly cancelled = new Set<string>();
  owns(): boolean { return false; }
  async cancel(executionId: string): Promise<boolean> { this.cancelled.add(executionId); return true; }
  async *run(request: ProcessRunRequest, signal?: AbortSignal): AsyncIterable<ProcessRunnerEvent> {
    yield { type: "started", ownership: { executionId: request.executionId, pid: 4242, processIdentity: `playwright-${request.executionId}`, startedAt: new Date().toISOString() } };
    for (const message of ["Codex test double received the immutable capsule.\n", "Codex test double completed without modifying files.\n"]) {
      if (signal?.aborted || this.cancelled.has(request.executionId)) {
        yield { type: "exit", result: { exitCode: null, signal: null, timedOut: false, cancelled: true, outputTruncated: false, stdoutBytes: 0, stderrBytes: 0 } };
        return;
      }
      yield { type: "stdout", message };
    }
    yield { type: "exit", result: { exitCode: 0, signal: null, timedOut: false, cancelled: false, outputTruncated: false, stdoutBytes: 96, stderrBytes: 0 } };
  }
}

const snapshot: CodexCapabilitySnapshot = {
  executorId: "codex-cli", executablePath: process.execPath, displayPath: "Playwright test double", version: "test-double",
  detectedAt: new Date().toISOString(), execAvailable: true, modelFlag: true, reasoningEffortMechanism: "UNKNOWN",
  sandboxModes: ["workspace-write"], approvalModes: ["never"], outputModes: ["jsonl"], workingDirectorySupport: true,
  timeoutManagedByRelay: true, cancellationManagedByRelay: true, authenticationStatus: "AUTHENTICATED",
  rawHelpHash: "0".repeat(64), supported: true, unsupportedReasons: []
};

export function createBrowserCodexTestDouble(): CodexCliExecutor {
  if (process.env.PROJECT_RELAY_TEST_MODE !== "true" || process.env.RELAY_V2_CODEX_TEST_DOUBLE !== "true" || !process.env.RELAY_V2_DATA_DIR?.includes("playwright-v2")) {
    throw new Error("The Codex process test double is restricted to the disposable Relay v2 Playwright environment.");
  }
  return new CodexCliExecutor({ discovery: { discover: async () => snapshot }, runner: new BrowserCodexProcessDouble() });
}
