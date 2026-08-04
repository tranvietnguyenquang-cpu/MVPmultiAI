import { describe, expect, it } from "vitest";
import type { ProcessRunRequest, ProcessRunner, ProcessRunnerEvent } from "@project-relay/relay-v2-execution";
import { runDisposableReadOnlyClaudeReviewSmoke } from "./disposable-claude-review-smoke.js";
import type { ClaudeCapabilitySnapshot } from "./claude-capabilities.js";
import { claudeCliV2_1_220WrapperFixture } from "./claude-cli-v2-1-220-wrapper.fixture.js";

const snapshot = (overrides: Partial<ClaudeCapabilitySnapshot> = {}): ClaudeCapabilitySnapshot => ({
  reviewerId: "claude-cli", executablePath: process.execPath, displayPath: "claude.exe", version: "2.1.220",
  detectedAt: new Date().toISOString(), printSupported: true, outputFormatJsonSupported: true, jsonSchemaSupported: true,
  toolsFlagSupported: true, safeModeSupported: true, strictMcpConfigSupported: true, noSessionPersistenceSupported: true,
  disableSlashCommandsSupported: true, authenticationStatus: "AUTHENTICATED", authMethod: "claude.ai",
  executableIdentityHash: "a".repeat(64), helpHash: "b".repeat(64),
  wrapperContractId: "claude-json-schema-result-v1", wrapperParserVersion: "1",
  supported: true, unsupportedReasons: [], ...overrides
});

class ApprovingRunner implements ProcessRunner {
  owns(): boolean { return false; }
  async cancel(): Promise<boolean> { return true; }
  async *run(request: ProcessRunRequest): AsyncIterable<ProcessRunnerEvent> {
    const stdin = request.stdin ?? "";
    const requestHash = /requestHash:\s*([a-f0-9]{64})/.exec(stdin)?.[1] ?? "0".repeat(64);
    const materialHash = /materialHash:\s*([a-f0-9]{64})/.exec(stdin)?.[1] ?? "0".repeat(64);
    const promptHash = /promptHash:\s*([a-f0-9]{64})/.exec(stdin)?.[1] ?? "0".repeat(64);
    const verdict = {
      reviewedRequestHash: requestHash, reviewedMaterialHash: materialHash, reviewedPromptHash: promptHash,
      verdict: "APPROVE" as const, summary: "Smoke double approve.", findings: [], requiredActions: [], confidence: 1, reviewerVersion: "double@1"
    };
    yield { type: "started", ownership: { executionId: request.executionId, pid: 1, processIdentity: "id", startedAt: new Date().toISOString() } };
    yield { type: "stdout", message: JSON.stringify(claudeCliV2_1_220WrapperFixture(verdict)) };
    yield { type: "exit", result: { exitCode: 0, signal: null, timedOut: false, cancelled: false, outputTruncated: false, stdoutBytes: 10, stderrBytes: 0 } };
  }
}

describe("runDisposableReadOnlyClaudeReviewSmoke (harness logic only, real CLI never invoked)", () => {
  it("returns SKIPPED, never invoking a process, when the CLI is unavailable", async () => {
    const result = await runDisposableReadOnlyClaudeReviewSmoke({ discovery: { discover: async () => snapshot({ supported: false, unsupportedReasons: ["not found"] }) } });
    expect(result.status).toBe("SKIPPED");
  });

  it("returns SKIPPED when the CLI is installed but not authenticated with a subscription", async () => {
    const result = await runDisposableReadOnlyClaudeReviewSmoke({ discovery: { discover: async () => snapshot({ authenticationStatus: "UNAUTHENTICATED" }) } });
    expect(result.status).toBe("SKIPPED");
  });

  it("returns PASSED with a matching reviewedRequestHash when the (doubled) process approves", async () => {
    const result = await runDisposableReadOnlyClaudeReviewSmoke({ discovery: { discover: async () => snapshot() }, runner: new ApprovingRunner() });
    expect(result.status).toBe("PASSED");
    if (result.status === "PASSED") {
      expect(result.reviewedRequestHash).toMatch(/^[a-f0-9]{64}$/);
      expect(result.verdict).toBe("APPROVE");
    }
  });

  it("still calls onRawInvocationOutcome with the exact raw stdout, and still fails the smoke, when the process output is not a recognized shape", async () => {
    class GarbageRunner implements ProcessRunner {
      owns(): boolean { return false; }
      async cancel(): Promise<boolean> { return true; }
      async *run(request: ProcessRunRequest): AsyncIterable<ProcessRunnerEvent> {
        yield { type: "started", ownership: { executionId: request.executionId, pid: 1, processIdentity: "id", startedAt: new Date().toISOString() } };
        yield { type: "stdout", message: '{"unexpectedWrapperField": true}' };
        yield { type: "stderr", message: "some diagnostic text" };
        yield { type: "exit", result: { exitCode: 0, signal: null, timedOut: false, cancelled: false, outputTruncated: false, stdoutBytes: 10, stderrBytes: 5 } };
      }
    }
    let observed: { stdout: string; stderr: string; exitCode: number | null } | undefined;
    await expect(
      runDisposableReadOnlyClaudeReviewSmoke({
        discovery: { discover: async () => snapshot() },
        runner: new GarbageRunner(),
        onRawInvocationOutcome: async outcome => { observed = outcome; }
      })
    ).rejects.toThrow();
    expect(observed?.stdout).toBe('{"unexpectedWrapperField": true}');
    expect(observed?.stderr).toBe("some diagnostic text");
    expect(observed?.exitCode).toBe(0);
  });
});
