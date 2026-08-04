import { ClaudeCliReviewer, type ClaudeCapabilitySnapshot } from "@project-relay/relay-v2-claude-reviewer";
import type { ProcessRunRequest, ProcessRunner, ProcessRunnerEvent } from "@project-relay/relay-v2-execution";

type Scenario = "approve" | "reject" | "needs_changes" | "invalid" | "failure" | "timeout" | "cancellation";

const SCENARIO_PATTERN = /RELAY_TEST_DOUBLE_SCENARIO:\s*(approve|reject|needs_changes|invalid|failure|timeout|cancellation)/i;

function scenarioFromStdin(stdin: string | undefined): Scenario {
  const match = stdin ? SCENARIO_PATTERN.exec(stdin) : null;
  return (match?.[1]?.toLowerCase() as Scenario | undefined) ?? "approve";
}

function requestHashFromStdin(stdin: string | undefined): string {
  const match = stdin ? /requestHash:\s*([a-f0-9]{64})/.exec(stdin) : null;
  return match?.[1] ?? "0".repeat(64);
}

function materialHashFromStdin(stdin: string | undefined): string {
  const match = stdin ? /materialHash:\s*([a-f0-9]{64})/.exec(stdin) : null;
  return match?.[1] ?? "0".repeat(64);
}

function promptHashFromStdin(stdin: string | undefined): string {
  const match = stdin ? /promptHash:\s*([a-f0-9]{64})/.exec(stdin) : null;
  return match?.[1] ?? "0".repeat(64);
}

/**
 * Never invoked outside the disposable Playwright/CI environment (see the
 * triple-gate in createBrowserClaudeReviewerTestDouble). Behaves like a real
 * ClaudeCliReviewer end-to-end -- same class, same parsing, same
 * bundle/argv/stdin plumbing -- except the process itself is this in-memory
 * double instead of the real `claude` binary, so this never spawns a process
 * or reaches the network.
 */
class BrowserClaudeProcessDouble implements ProcessRunner {
  private readonly cancelled = new Set<string>();
  owns(): boolean { return false; }
  async cancel(executionId: string): Promise<boolean> { this.cancelled.add(executionId); return true; }

  async *run(request: ProcessRunRequest, signal?: AbortSignal): AsyncIterable<ProcessRunnerEvent> {
    const ownership = { executionId: request.executionId, pid: 4343, processIdentity: `playwright-claude-${request.executionId}`, startedAt: new Date().toISOString() };
    yield { type: "started", ownership };
    const scenario = scenarioFromStdin(request.stdin);
    const requestHash = requestHashFromStdin(request.stdin);
    const materialHash = materialHashFromStdin(request.stdin);
    const promptHash = promptHashFromStdin(request.stdin);

    if (scenario === "cancellation") {
      while (!signal?.aborted && !this.cancelled.has(request.executionId)) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      yield { type: "exit", result: { exitCode: null, signal: null, timedOut: false, cancelled: true, outputTruncated: false, stdoutBytes: 0, stderrBytes: 0 } };
      return;
    }
    if (scenario === "timeout") {
      yield { type: "exit", result: { exitCode: null, signal: null, timedOut: true, cancelled: false, outputTruncated: false, stdoutBytes: 0, stderrBytes: 0 } };
      return;
    }
    if (scenario === "failure") {
      yield { type: "stderr", message: "claude test double: simulated failure\n" };
      yield { type: "exit", result: { exitCode: 1, signal: null, timedOut: false, cancelled: false, outputTruncated: false, stdoutBytes: 0, stderrBytes: 32 } };
      return;
    }
    if (scenario === "invalid") {
      yield { type: "stdout", message: "not valid json at all {{{" };
      yield { type: "exit", result: { exitCode: 0, signal: null, timedOut: false, cancelled: false, outputTruncated: false, stdoutBytes: 24, stderrBytes: 0 } };
      return;
    }

    const base = { reviewedRequestHash: requestHash, reviewedMaterialHash: materialHash, reviewedPromptHash: promptHash, summary: `Claude test double completed a ${scenario} scenario.`, confidence: 1, reviewerVersion: "claude-cli-test-double@1" };
    const verdict = scenario === "reject"
      ? { ...base, verdict: "REJECT", findings: [{ id: "double-reject-1", severity: "BLOCKER", category: "diagnostic", title: "Test double rejection", description: "Claude test double scenario requested a rejection.", evidenceReferences: [], blocking: true }], requiredActions: [] }
      : scenario === "needs_changes"
      ? { ...base, verdict: "NEEDS_CHANGES", findings: [], requiredActions: ["Address the test double's requested change."] }
      : { ...base, verdict: "APPROVE", findings: [], requiredActions: [] };

    const message = JSON.stringify(verdict);
    yield { type: "stdout", message };
    yield { type: "exit", result: { exitCode: 0, signal: null, timedOut: false, cancelled: false, outputTruncated: false, stdoutBytes: Buffer.byteLength(message), stderrBytes: 0 } };
  }
}

const TEST_DOUBLE_SNAPSHOT: ClaudeCapabilitySnapshot = {
  reviewerId: "claude-cli", executablePath: process.execPath, displayPath: "Playwright test double", version: "test-double",
  detectedAt: new Date().toISOString(), printSupported: true, outputFormatJsonSupported: true, jsonSchemaSupported: true,
  toolsFlagSupported: true, safeModeSupported: true, strictMcpConfigSupported: true, noSessionPersistenceSupported: true,
  disableSlashCommandsSupported: true, authenticationStatus: "AUTHENTICATED", authMethod: "claude.ai",
  executableIdentityHash: "1".repeat(64), helpHash: "2".repeat(64),
  wrapperContractId: "claude-json-schema-result-v1", wrapperParserVersion: "1",
  supported: true, unsupportedReasons: []
};

export function createBrowserClaudeReviewerTestDouble(): ClaudeCliReviewer {
  if (
    process.env.PROJECT_RELAY_TEST_MODE !== "true"
    || process.env.RELAY_V2_CLAUDE_TEST_DOUBLE !== "true"
    || !process.env.RELAY_V2_DATA_DIR?.includes("playwright-v2")
  ) {
    throw new Error("The Claude CLI process test double is restricted to the disposable Relay v2 Playwright environment.");
  }
  return new ClaudeCliReviewer({
    discovery: { discover: async () => TEST_DOUBLE_SNAPSHOT },
    runner: new BrowserClaudeProcessDouble(),
    // Only this gated factory may request the bare-verdict test-double
    // parser; production construction of ClaudeCliReviewer never sets this.
    allowBareVerdictTestDouble: true
  });
}
