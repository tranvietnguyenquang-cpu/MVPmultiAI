import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { ClaudeCliProvider, CodexCliProvider, classifyModelProbe } from "./index.js";

const resolver = async (command: "codex" | "claude") => ({ command, canonicalPath: `C:\\safe\\${command}.cmd` });

type SpawnCall = { command: string; args: string[]; options: Record<string, unknown> };

function recordingSpawn(calls: SpawnCall[], output = "") {
  return ((command: string, args: string[], options: Record<string, unknown>) => {
    calls.push({ command, args, options });
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: PassThrough; kill: () => boolean };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => { queueMicrotask(() => child.emit("close", null)); return true; };
    queueMicrotask(() => { child.stdout.end(output); child.emit("close", 0); });
    return child;
  }) as never;
}

function mockSpawnController() {
  let child: any;
  let resolveReady: () => void;
  const ready = new Promise<void>(resolve => { resolveReady = resolve; });
  const spawn = ((_: string, _args: string[]) => {
    child = new EventEmitter() as any;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => { queueMicrotask(() => child.emit("close", null)); return true; };
    resolveReady();
    return child;
  }) as any;
  const tick = () => new Promise<void>(resolve => setImmediate(resolve));
  return {
    spawn, ready,
    writeStdout: async (chunk: string) => { child.stdout.write(chunk); await tick(); },
    close: async (code: number | null) => { child.stdout.end(); await tick(); child.emit("close", code); }
  };
}

describe("Claude CLI model selection", () => {
  it("omits --model when Default is selected", async () => {
    const calls: SpawnCall[] = [];
    const provider = new ClaudeCliProvider(recordingSpawn(calls), resolver);
    const session = await provider.createSession({ workspace: "C:\\MVPmultiAI", taskId: "t", capability: "READ_ONLY" });
    await provider.startSession(session, {} as never);
    expect(calls[0]!.args).not.toContain("--model");
  });

  it("passes --model sonnet when Sonnet is explicitly selected", async () => {
    const calls: SpawnCall[] = [];
    const provider = new ClaudeCliProvider(recordingSpawn(calls), resolver);
    const session = await provider.createSession({ workspace: "C:\\MVPmultiAI", taskId: "t", capability: "READ_ONLY", model: "sonnet" });
    await provider.startSession(session, {} as never);
    const modelIndex = calls[0]!.args.indexOf("--model");
    expect(modelIndex).toBeGreaterThanOrEqual(0);
    expect(calls[0]!.args[modelIndex + 1]).toBe("sonnet");
  });

  it("passes --model opus when Opus is explicitly selected", async () => {
    const calls: SpawnCall[] = [];
    const provider = new ClaudeCliProvider(recordingSpawn(calls), resolver);
    const session = await provider.createSession({ workspace: "C:\\MVPmultiAI", taskId: "t", capability: "READ_ONLY", model: "opus" });
    await provider.startSession(session, {} as never);
    const modelIndex = calls[0]!.args.indexOf("--model");
    expect(calls[0]!.args[modelIndex + 1]).toBe("opus");
  });

  it("keeps a model id with shell metacharacters as a single argv element, never interpreted as extra flags", async () => {
    const calls: SpawnCall[] = [];
    const provider = new ClaudeCliProvider(recordingSpawn(calls), resolver);
    const injected = "opus --dangerously-skip-permissions; rm -rf /";
    const session = await provider.createSession({ workspace: "C:\\MVPmultiAI", taskId: "t", capability: "READ_ONLY", model: injected });
    await provider.startSession(session, {} as never);
    const modelIndex = calls[0]!.args.indexOf("--model");
    expect(calls[0]!.args[modelIndex + 1]).toBe(injected);
    expect(calls[0]!.args).not.toContain("--dangerously-skip-permissions");
    expect(calls[0]!.args.filter(a => a === "--model")).toHaveLength(1);
  });

  it("extracts the resolved model from the system/init event, not from a later synthetic assistant message", async () => {
    const ctrl = mockSpawnController();
    const provider = new ClaudeCliProvider(ctrl.spawn, resolver);
    const session = await provider.createSession({ workspace: "C:\\MVPmultiAI", taskId: "t", capability: "READ_ONLY", model: "opus" });
    const run = provider.startSession(session, {} as never);
    await ctrl.ready;
    await ctrl.writeStdout('{"type":"system","subtype":"init","session_id":"s1","model":"claude-opus-4-8"}\n');
    await ctrl.writeStdout('{"type":"assistant","message":{"model":"claude-opus-4-8","content":[{"type":"text","text":"hi"}]}}\n');
    await ctrl.writeStdout('{"type":"result","subtype":"success","is_error":false,"result":"hi"}\n');
    await ctrl.close(0);
    await expect(run).resolves.toBeUndefined();
    expect(session.resolvedModel).toBe("claude-opus-4-8");
  });

  it("does not fabricate a resolved model when the stream never reports one", async () => {
    const ctrl = mockSpawnController();
    const provider = new ClaudeCliProvider(ctrl.spawn, resolver);
    const session = await provider.createSession({ workspace: "C:\\MVPmultiAI", taskId: "t", capability: "READ_ONLY", model: "opus" });
    const run = provider.startSession(session, {} as never);
    await ctrl.ready;
    await ctrl.writeStdout('{"type":"result","subtype":"success","is_error":false,"result":"hi"}\n');
    await ctrl.close(0);
    await expect(run).resolves.toBeUndefined();
    expect(session.resolvedModel).toBeUndefined();
  });

  it("builds a harmless, read-only model-validation probe command carrying the model under test", () => {
    const provider = new ClaudeCliProvider(recordingSpawn([]), resolver);
    const command = (provider as unknown as { modelProbeCommand(id: string): { args: string[]; prompt: string; marker: string } }).modelProbeCommand("opus");
    expect(command.args).toEqual(expect.arrayContaining(["--model", "opus", "--disallowedTools", "Edit", "Write"]));
    expect(command.args).not.toContain("--dangerously-skip-permissions");
    expect(command.marker).toBe("MODEL_OK");
  });
});

describe("Codex CLI model selection", () => {
  it("omits -m/--model and reasoning-effort config when Default is selected", async () => {
    const calls: SpawnCall[] = [];
    const provider = new CodexCliProvider(recordingSpawn(calls), resolver);
    const session = await provider.createSession({ workspace: "C:\\MVPmultiAI", taskId: "t", capability: "READ_ONLY" });
    await provider.startSession(session, {} as never);
    expect(calls[0]!.args).not.toContain("-m");
    expect(calls[0]!.args).not.toContain("--model");
    expect(calls[0]!.args.join(" ")).not.toContain("model_reasoning_effort");
  });

  it("passes the selected model via -m safely as its own argv element", async () => {
    const calls: SpawnCall[] = [];
    const provider = new CodexCliProvider(recordingSpawn(calls), resolver);
    const session = await provider.createSession({ workspace: "C:\\MVPmultiAI", taskId: "t", capability: "READ_ONLY", model: "o3" });
    await provider.startSession(session, {} as never);
    const modelIndex = calls[0]!.args.indexOf("-m");
    expect(modelIndex).toBeGreaterThanOrEqual(0);
    expect(calls[0]!.args[modelIndex + 1]).toBe("o3");
  });

  it("keeps an injected model id as a single argv element, never splitting into extra flags", async () => {
    const calls: SpawnCall[] = [];
    const provider = new CodexCliProvider(recordingSpawn(calls), resolver);
    const injected = "o3 --dangerously-bypass-approvals-and-sandbox";
    const session = await provider.createSession({ workspace: "C:\\MVPmultiAI", taskId: "t", capability: "READ_ONLY", model: injected });
    await provider.startSession(session, {} as never);
    const modelIndex = calls[0]!.args.indexOf("-m");
    expect(calls[0]!.args[modelIndex + 1]).toBe(injected);
    expect(calls[0]!.args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("passes reasoning effort only through the -c model_reasoning_effort= config mechanism, and only alongside a selected model", async () => {
    const calls: SpawnCall[] = [];
    const provider = new CodexCliProvider(recordingSpawn(calls), resolver);
    const session = await provider.createSession({ workspace: "C:\\MVPmultiAI", taskId: "t", capability: "READ_ONLY", model: "o3", reasoningEffort: "high" });
    await provider.startSession(session, {} as never);
    const configIndex = calls[0]!.args.indexOf("-c");
    expect(configIndex).toBeGreaterThanOrEqual(0);
    expect(calls[0]!.args[configIndex + 1]).toBe("model_reasoning_effort=high");
  });

  it("never passes reasoning effort without an explicit model (effort is meaningless without one)", async () => {
    const calls: SpawnCall[] = [];
    const provider = new CodexCliProvider(recordingSpawn(calls), resolver);
    const session = await provider.createSession({ workspace: "C:\\MVPmultiAI", taskId: "t", capability: "READ_ONLY", reasoningEffort: "high" });
    await provider.startSession(session, {} as never);
    expect(calls[0]!.args.join(" ")).not.toContain("model_reasoning_effort");
  });

  it("preserves the model flag through a resumed session", async () => {
    const calls: SpawnCall[] = [];
    const provider = new CodexCliProvider(recordingSpawn(calls), resolver);
    const session = await provider.createSession({ workspace: "C:\\MVPmultiAI", taskId: "t", capability: "READ_ONLY", model: "o3", resumeExternalId: "codex-thread-1" });
    await provider.resumeSession(session, {} as never);
    expect(calls[0]!.args[0]).toBe("exec");
    expect(calls[0]!.args[1]).toBe("resume");
    expect(calls[0]!.args[2]).toBe("codex-thread-1");
    const modelIndex = calls[0]!.args.indexOf("-m");
    expect(calls[0]!.args[modelIndex + 1]).toBe("o3");
  });

  it("builds a harmless, read-only model-validation probe command carrying the model under test", () => {
    const provider = new CodexCliProvider(recordingSpawn([]), resolver);
    const command = (provider as unknown as { modelProbeCommand(id: string, effort?: string): { args: string[]; prompt: string; marker: string } }).modelProbeCommand("o3", "high");
    expect(command.args).toEqual(expect.arrayContaining(["-m", "o3", "-c", "model_reasoning_effort=high", "--sandbox", "read-only"]));
    expect(command.marker).toBe("MODEL_OK");
  });
});

describe("classifyModelProbe", () => {
  it("reports AVAILABLE only when the marker was actually observed on a clean exit", () => {
    expect(classifyModelProbe("MODEL_OK", 0, "MODEL_OK", { timedOut: false, cancelled: false })).toBe("AVAILABLE");
  });
  it("never fabricates availability from a clean exit with no marker", () => {
    expect(classifyModelProbe("something else entirely", 0, "MODEL_OK", { timedOut: false, cancelled: false })).toBe("UNKNOWN");
  });
  it("classifies an unsupported/unknown model clearly", () => {
    expect(classifyModelProbe("There's an issue with the selected model (bogus-model). It may not exist or you may not have access to it.", 0, "MODEL_OK", { timedOut: false, cancelled: false })).toBe("UNSUPPORTED");
    expect(classifyModelProbe(JSON.stringify({ error: "model_not_found" }), 0, "MODEL_OK", { timedOut: false, cancelled: false })).toBe("UNSUPPORTED");
  });
  it("classifies rate limiting distinctly from unsupported", () => {
    expect(classifyModelProbe("429 too many requests", 1, "MODEL_OK", { timedOut: false, cancelled: false })).toBe("RATE_LIMITED");
  });
  it("classifies a timeout/cancellation as UNKNOWN, never AVAILABLE", () => {
    expect(classifyModelProbe("", null, "MODEL_OK", { timedOut: true, cancelled: false })).toBe("UNKNOWN");
    expect(classifyModelProbe("MODEL_OK", 0, "MODEL_OK", { timedOut: false, cancelled: true })).toBe("UNKNOWN");
  });
});
