import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { ClaudeCliProvider } from "./claude-cli-provider.js";
import { CodexCliProvider } from "./codex-cli-provider.js";
import type { ProviderProcessLifecycle } from "./types.js";

const resolver = async (command: "codex" | "claude") => ({ command, canonicalPath: `C:\\safe\\${command}.cmd` });

function spawnStructured(output: string, pid = 41_000) {
  return (() => {
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      stdout: PassThrough;
      stderr: PassThrough;
      stdin: PassThrough;
      kill: () => boolean;
    };
    child.pid = pid;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {
      child.emit("close", null);
      return true;
    };
    setTimeout(() => {
      child.stdout.end(output);
      child.emit("close", 0);
    }, 5);
    return child;
  }) as never;
}

function lifecycle(overrides: Partial<ProviderProcessLifecycle> = {}) {
  const captureProcessStart = vi.fn(async (pid: number) => ({
    pid,
    processStartIdentity: "2026-07-23T00:00:00.000Z",
    processStartedAt: new Date("2026-07-23T00:00:00.000Z"),
  }));
  const onProcessStarted = vi.fn(async () => undefined);
  const onProcessStartFailure = vi.fn(async () => undefined);
  return {
    processLifecycle: { captureProcessStart, onProcessStarted, onProcessStartFailure, ...overrides },
    captureProcessStart,
    onProcessStarted,
    onProcessStartFailure,
  };
}

describe("provider spawn ownership lifecycle", () => {
  it.each([
    ["Codex", CodexCliProvider, '{"type":"task_complete"}\n'],
    ["Claude", ClaudeCliProvider, '{"type":"result","subtype":"success","is_error":false,"result":"ok"}\n'],
  ])("invokes the shared ownership callback for %s before processing output", async (_name, Provider, output) => {
    const hook = lifecycle();
    const provider = new Provider(spawnStructured(output, 42_001), resolver);
    const session = await provider.createSession({
      workspace: "C:\\MVPmultiAI",
      taskId: "task",
      capability: "READ_ONLY",
      processLifecycle: hook.processLifecycle,
    });

    await provider.startSession(session, {} as never);

    expect(hook.captureProcessStart).toHaveBeenCalledWith(42_001);
    expect(hook.onProcessStarted).toHaveBeenCalledWith({
      pid: 42_001,
      processStartIdentity: "2026-07-23T00:00:00.000Z",
      processStartedAt: new Date("2026-07-23T00:00:00.000Z"),
    });
  });

  it("fails closed before output listeners are installed when ownership capture fails", async () => {
    const hook = lifecycle({ captureProcessStart: async () => { throw new Error("identity unavailable"); } });
    const provider = new CodexCliProvider(spawnStructured('{"type":"agent_message","message":"must not persist"}\n', 42_002), resolver);
    const session = await provider.createSession({
      workspace: "C:\\MVPmultiAI",
      taskId: "task",
      capability: "READ_ONLY",
      processLifecycle: hook.processLifecycle,
    });

    await expect(provider.startSession(session, {} as never)).rejects.toThrow("PROVIDER_OWNERSHIP_FAILURE");
    const events = [];
    for await (const event of provider.streamEvents(session.id)) events.push(event);
    expect(events).toEqual([]);
    expect(hook.onProcessStartFailure).toHaveBeenCalledWith(expect.objectContaining({ pid: 42_002 }));
  });

  it("fails closed when ownership persistence rejects after identity capture", async () => {
    const hook = lifecycle({ onProcessStarted: async () => { throw new Error("database unavailable"); } });
    const provider = new ClaudeCliProvider(spawnStructured('{"type":"result","subtype":"success","is_error":false,"result":"must not persist"}\n', 42_003), resolver);
    const session = await provider.createSession({
      workspace: "C:\\MVPmultiAI",
      taskId: "task",
      capability: "READ_ONLY",
      processLifecycle: hook.processLifecycle,
    });

    await expect(provider.startSession(session, {} as never)).rejects.toThrow("PROVIDER_OWNERSHIP_FAILURE");
    const events = [];
    for await (const event of provider.streamEvents(session.id)) events.push(event);
    expect(events).toEqual([]);
    expect(hook.captureProcessStart).toHaveBeenCalledWith(42_003);
    expect(hook.onProcessStartFailure).toHaveBeenCalledWith(expect.objectContaining({ pid: 42_003 }));
  });
});
