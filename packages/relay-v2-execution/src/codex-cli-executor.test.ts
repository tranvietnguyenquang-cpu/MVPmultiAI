import { describe, expect, it, vi } from "vitest";
import type { CodexCapabilitySnapshot } from "./codex-capabilities.js";
import { buildCodexArgv, CodexCliExecutor } from "./codex-cli-executor.js";
import type { ExecutionContext } from "./executor-contract.js";
import type { ProcessRunRequest, ProcessRunner, ProcessRunnerEvent } from "./process-runner.js";

const capability = (overrides: Partial<CodexCapabilitySnapshot> = {}): CodexCapabilitySnapshot => ({
  executorId: "codex-cli", executablePath: process.execPath, displayPath: "node.exe", version: "0.146.0-alpha.9.2",
  detectedAt: new Date().toISOString(), execAvailable: true, modelFlag: true,
  reasoningEffortMechanism: "UNKNOWN", sandboxModes: ["workspace-write"], approvalModes: ["never"],
  outputModes: ["jsonl"], workingDirectorySupport: true, timeoutManagedByRelay: true, cancellationManagedByRelay: true,
  authenticationStatus: "AUTHENTICATED", rawHelpHash: "a".repeat(64), supported: true, unsupportedReasons: [], ...overrides
});

class CodexProcessDouble implements ProcessRunner {
  request?: ProcessRunRequest;
  owns(): boolean { return false; }
  async cancel(): Promise<boolean> { return true; }
  async *run(request: ProcessRunRequest): AsyncIterable<ProcessRunnerEvent> {
    this.request = request;
    yield { type: "started", ownership: { executionId: request.executionId, pid: 42, processIdentity: "owned", startedAt: "2026-08-02T00:00:00.000Z" } };
    yield { type: "stdout", message: "{\"type\":\"item.completed\"}\n" };
    yield { type: "exit", result: { exitCode: 0, signal: null, timedOut: false, cancelled: false, outputTruncated: false, stdoutBytes: 20, stderrBytes: 0 } };
  }
}

function validationRequest() {
  return {
    sessionId: "session", workspacePath: process.cwd(), approvedExecutor: "CODEX", approvedModel: "AUTO", approvedEffort: "AUTO",
    approvedPermissions: [
      { permission: "ALLOW_SOURCE_TRANSMISSION_TO_API" as const, value: false },
      { permission: "WORKSPACE_WRITE" as const, value: true },
      { permission: "NON_PRODUCTION_CONFIRMED" as const, value: true },
      { permission: "ALLOW_DIRTY_WORKSPACE" as const, value: false },
      { permission: "TIMEOUT_SECONDS" as const, value: 1800 },
      { permission: "VERIFICATION_OPERATIONS" as const, value: [] }
    ], timeoutMs: 1_800_000, verificationOperations: []
  };
}

describe("CodexCliExecutor", () => {
  it("builds a shell-free argv array and omits AUTO model and effort", () => {
    const argv = buildCodexArgv({ workspacePath: "C:\\Work Space\\项目", model: "AUTO", effort: "AUTO", capabilities: capability(), supportedModels: [], supportedEfforts: {} });
    expect(argv).toEqual(["-a", "never", "exec", "--ephemeral", "--ignore-user-config", "--color", "never", "--json", "-s", "workspace-write", "-C", "C:\\Work Space\\项目", "-"]);
    expect(argv).not.toContain("--model");
  });

  it("includes only verified explicit model and effort configuration", () => {
    expect(buildCodexArgv({
      workspacePath: "/work", model: "verified-model", effort: "HIGH", capabilities: capability(),
      supportedModels: ["verified-model"], supportedEfforts: { HIGH: ["-c", "model_reasoning_effort=\"high\""] }
    })).toEqual(expect.arrayContaining(["--model", "verified-model", "-c", "model_reasoning_effort=\"high\""]));
    expect(() => buildCodexArgv({ workspacePath: "/work", model: "invented", effort: "AUTO", capabilities: capability(), supportedModels: [], supportedEfforts: {} })).toThrow(/verified local Codex catalog/);
    expect(() => buildCodexArgv({ workspacePath: "/work", model: "AUTO", effort: "HIGH", capabilities: capability(), supportedModels: [], supportedEfforts: {} })).toThrow(/not supported/);
  });

  it("blocks unavailable authentication and missing write authority", async () => {
    const unauthenticated = new CodexCliExecutor({ discovery: { discover: async () => capability({ authenticationStatus: "UNAUTHENTICATED" }) } });
    expect(await unauthenticated.validate(validationRequest())).toEqual({ valid: false, reason: "Codex CLI is installed but not logged in." });
    const executor = new CodexCliExecutor({ discovery: { discover: async () => capability() } });
    const request = validationRequest();
    request.approvedPermissions[1] = { permission: "WORKSPACE_WRITE", value: false };
    expect(await executor.validate(request)).toEqual({ valid: false, reason: "Codex CLI requires approved workspace-write permission." });
  });

  it("refreshes stale diagnostics and authentication at execution validation time", async () => {
    const discover = vi.fn()
      .mockResolvedValueOnce(capability({ detectedAt: "2026-08-01T00:00:00.000Z", authenticationStatus: "UNAUTHENTICATED" }))
      .mockResolvedValueOnce(capability({ detectedAt: "2026-08-03T00:00:00.000Z", authenticationStatus: "AUTHENTICATED" }));
    const executor = new CodexCliExecutor({ discovery: { discover }, now: () => new Date("2026-08-03T00:00:01.000Z"), capabilityFreshnessMs: 1_000 });
    expect((await executor.refreshCapabilities()).authenticationStatus).toBe("UNAUTHENTICATED");
    expect((await executor.capabilities()).authenticationStatus).toBe("AUTHENTICATED");
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it("observes authentication changes between manual diagnostics and execution authority", async () => {
    const discover = vi.fn()
      .mockResolvedValueOnce(capability({ authenticationStatus: "UNAUTHENTICATED" }))
      .mockResolvedValueOnce(capability({ authenticationStatus: "AUTHENTICATED" }));
    const processDouble = new CodexProcessDouble();
    const executor = new CodexCliExecutor({ discovery: { discover }, runner: processDouble });
    expect((await executor.refreshCapabilities()).authenticationStatus).toBe("UNAUTHENTICATED");
    expect(await executor.validate(validationRequest())).toEqual({ valid: true });
    expect(discover).toHaveBeenCalledTimes(2);
    expect(processDouble.request).toBeUndefined();
  });

  it("keeps unavailable login status unknown and never equates diagnostics with task execution", async () => {
    const processDouble = new CodexProcessDouble();
    const executor = new CodexCliExecutor({
      discovery: { discover: async () => capability({ authenticationStatus: "UNKNOWN" }) }, runner: processDouble
    });
    expect(await executor.validate(validationRequest())).toEqual({ valid: false, reason: "Codex CLI authentication could not be verified." });
    expect(processDouble.request).toBeUndefined();
  });

  it("passes task prose through stdin, never argv, and reports exact process truth", async () => {
    const processDouble = new CodexProcessDouble();
    const executor = new CodexCliExecutor({ discovery: { discover: async () => capability() }, runner: processDouble });
    const context = {
      ...validationRequest(), taskId: "task", projectId: "project", title: "Title", objective: "; Remove-Item -Recurse C:\\",
      taskContext: "context", constraints: [], acceptanceCriteria: ["safe"], approvedReviewer: "NONE",
      capsule: { capsuleHash: "b".repeat(64), objective: "; Remove-Item -Recurse C:\\" }
    } as unknown as ExecutionContext;
    const prepared = await executor.prepare(context);
    expect(prepared.argv?.join(" ")).not.toContain("Remove-Item");
    const events = [];
    for await (const event of executor.execute(prepared, { signal: new AbortController().signal, now: () => new Date(), sleep: async () => {} })) events.push(event);
    expect(processDouble.request?.stdin).toContain("Remove-Item");
    expect(processDouble.request?.args).toEqual(prepared.argv);
    expect(events.at(-1)).toMatchObject({ type: "result", payload: { success: true, exitCode: 0 } });
  });
});
