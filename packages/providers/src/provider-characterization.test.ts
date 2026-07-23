import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  ClaudeCliProvider,
  CodexCliProvider,
  ProviderRegistry,
  classifyProviderProbe,
} from "./index.js";

const resolver = async (command: "codex" | "claude") => ({
  command,
  canonicalPath: `C:\\safe\\${command}.cmd`,
});

type SpawnCall = { command: string; args: string[]; options: Record<string, unknown> };

function recordingSpawn(calls: SpawnCall[], output = "") {
  return ((command: string, args: string[], options: Record<string, unknown>) => {
    calls.push({ command, args, options });
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      stdin: PassThrough;
      kill: () => boolean;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {
      queueMicrotask(() => child.emit("close", null));
      return true;
    };
    queueMicrotask(() => {
      child.stdout.end(output);
      child.emit("close", 0);
    });
    return child;
  }) as never;
}

describe("provider runtime characterization", () => {
  it("keeps stable registry resolution and provider roles", () => {
    const registry = new ProviderRegistry([
      new CodexCliProvider(recordingSpawn([]), resolver),
      new ClaudeCliProvider(recordingSpawn([]), resolver),
    ]);

    expect(registry.get("codex-cli").defaultRoles).toEqual(["IMPLEMENTER"]);
    expect(registry.get("claude-cli").defaultRoles).toEqual(["REVIEWER", "VERIFIER"]);
    expect(() => registry.get("unknown")).toThrow("Unknown provider 'unknown'.");
  });

  it("uses the established Codex sandbox, structured output, session, and runner options", async () => {
    const calls: SpawnCall[] = [];
    const provider = new CodexCliProvider(recordingSpawn(calls), resolver);
    const session = await provider.createSession({
      workspace: "C:\\MVPmultiAI",
      taskId: "task-1",
      capability: "WORKSPACE_WRITE",
    });

    await provider.startSession(session, {} as never);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: "C:\\safe\\codex.cmd",
      options: { cwd: "C:\\MVPmultiAI", shell: false, windowsHide: true },
    });
    expect(calls[0]!.args).toEqual([
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
      "--cd",
      "C:\\MVPmultiAI",
      "-",
    ]);
    expect(await provider.getUsage(session.id)).toMatchObject({ estimated: true });
  });

  it("uses Claude's read-only structured stream flags and resume input", async () => {
    const calls: SpawnCall[] = [];
    const provider = new ClaudeCliProvider(recordingSpawn(calls), resolver);
    const session = await provider.createSession({
      workspace: "C:\\MVPmultiAI",
      taskId: "task-2",
      capability: "READ_ONLY",
      resumeExternalId: "claude-session-1",
    });

    await provider.resumeSession(session, {} as never);

    expect(calls[0]!.args).toEqual(expect.arrayContaining([
      "-p",
      "--verbose",
      "--output-format",
      "stream-json",
      "--permission-mode",
      "dontAsk",
      "--allowedTools",
      "Read",
      "--disallowedTools",
      "Edit",
      "Write",
      "--resume",
      "claude-session-1",
    ]));
    expect(calls[0]!.args).not.toContain("workspace-write");
    await expect(provider.createSession({
      workspace: "C:\\MVPmultiAI",
      taskId: "task-3",
      capability: "WORKSPACE_WRITE",
    })).rejects.toThrow(/does not support/i);
  });

  it("preserves existing authentication error classification", () => {
    expect(classifyProviderProbe("CODEX_OK", 0, "CODEX_OK", { timedOut: false, cancelled: false }))
      .toBe("AUTHENTICATED");
    expect(classifyProviderProbe("429 rate limit", 1, "CODEX_OK", { timedOut: false, cancelled: false }))
      .toBe("RATE_LIMITED");
    expect(classifyProviderProbe("", null, "CODEX_OK", { timedOut: true, cancelled: false }))
      .toBe("UNKNOWN");
  });

  it("passes the established probe timeout and output cap to the shared process runner", async () => {
    const provider = new CodexCliProvider(recordingSpawn([]), resolver);
    const execute = vi.spyOn(provider as never, "execute" as never).mockResolvedValue({
      code: 0,
      output: "CODEX_OK",
      durationMs: 12,
      timedOut: false,
      cancelled: false,
    } as never);

    const result = await provider.testConnection();

    expect(execute).toHaveBeenCalledWith(
      ["exec", "--json", "--sandbox", "read-only", "--skip-git-repo-check", "-"],
      "Reply with exactly CODEX_OK. Do not read or modify files.",
      undefined,
      60_000,
      16_384,
    );
    expect(result).toMatchObject({
      ok: true,
      output: "Provider probe completed; inspect persisted health status for details.",
      markerObserved: true,
      exitCode: 0,
      probe: { providerId: "codex-cli", authentication: "AUTHENTICATED" },
    });
  });
});
