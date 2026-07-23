import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { CodexCliProvider } from "./codex-cli-provider.js";
import {
  CliExecutableResolutionError,
  resolveCliExecutable,
} from "./executable.js";

const canonicalize = async (candidate: string) => candidate;
const accessible = async () => undefined;

describe("Windows provider executable resolution", () => {
  it("skips an inaccessible Windows App alias and selects a launchable npm cmd shim", async () => {
    const launches: Array<{ candidate: string; launcherType: string }> = [];
    const resolved = await resolveCliExecutable("codex", {
      platform: "win32",
      pathValue: "C:\\Program Files\\WindowsApps;C:\\Users\\local user\\AppData\\Roaming\\npm",
      accessFile: accessible,
      canonicalize,
      launchCandidate: async (candidate, launcherType) => {
        launches.push({ candidate, launcherType });
        return candidate.includes("WindowsApps")
          ? { ok: false, failureCode: "CLI_ACCESS_DENIED" }
          : { ok: candidate.endsWith("codex.cmd") };
      },
    });

    expect(resolved).toMatchObject({
      canonicalPath: "C:\\Users\\local user\\AppData\\Roaming\\npm\\codex.cmd",
      launcherType: "cmd-shim",
    });
    expect(launches[0]?.candidate).toContain("WindowsApps");
  });

  it("uses PATH order and native executable priority deterministically when candidates are valid", async () => {
    const resolved = await resolveCliExecutable("codex", {
      platform: "win32",
      pathValue: "C:\\first;C:\\second",
      accessFile: accessible,
      canonicalize,
      launchCandidate: async () => ({ ok: true }),
    });

    expect(resolved).toMatchObject({ canonicalPath: "C:\\first\\codex.exe", launcherType: "native-exe" });
  });

  it("adds the server-discovered npm global bin only after PATH candidates", async () => {
    const launches: string[] = [];
    const resolved = await resolveCliExecutable("codex", {
      platform: "win32",
      pathValue: "C:\\WindowsApps",
      npmPrefix: async () => "C:\\global npm",
      accessFile: accessible,
      canonicalize,
      launchCandidate: async (candidate) => {
        launches.push(candidate);
        return candidate.includes("WindowsApps") ? { ok: false, failureCode: "CLI_ACCESS_DENIED" } : { ok: true };
      },
    });

    expect(resolved?.canonicalPath).toBe("C:\\global npm\\codex.exe");
    expect(launches).toEqual(["C:\\WindowsApps\\codex.exe", "C:\\WindowsApps\\codex.cmd", "C:\\global npm\\codex.exe"]);
  });

  it("reports Access Denied when every discovered candidate is inaccessible", async () => {
    await expect(resolveCliExecutable("codex", {
      platform: "win32",
      pathValue: "C:\\WindowsApps",
      accessFile: accessible,
      canonicalize,
      launchCandidate: async () => ({ ok: false, failureCode: "CLI_ACCESS_DENIED" }),
    })).rejects.toMatchObject({ code: "CLI_ACCESS_DENIED" } satisfies Partial<CliExecutableResolutionError>);
  });

  it("uses safe direct command and argument-array invocation for cmd shims", async () => {
    const seen: string[] = [];
    await resolveCliExecutable("codex", {
      platform: "win32",
      pathValue: "C:\\Program Files\\Codex",
      accessFile: async (candidate) => {
        if (!candidate.endsWith(".cmd")) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
      canonicalize,
      launchCandidate: async (candidate, launcherType) => {
        seen.push(`${launcherType}:${candidate}`);
        return { ok: true };
      },
    });

    expect(seen).toEqual(["cmd-shim:C:\\Program Files\\Codex\\codex.cmd"]);
  });

  it("does not permit callers to select an arbitrary executable name", async () => {
    await expect(resolveCliExecutable("C:\\untrusted\\tool.exe" as never)).rejects.toMatchObject({
      code: "CLI_NOT_FOUND",
    });
  });

  it("invalidates a cached candidate after a later file-not-found launch failure", async () => {
    let resolutions = 0;
    const provider = new CodexCliProvider(((command: string) => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
        stdin: PassThrough;
        kill: () => boolean;
      };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.kill = () => true;
      queueMicrotask(() => {
        if (command.includes("stale")) {
          child.emit("error", Object.assign(new Error("missing"), { code: "ENOENT" }));
          child.emit("close", null);
          return;
        }
        child.stdout.end("CODEX_OK");
        child.emit("close", 0);
      });
      return child;
    }) as never, async () => {
      resolutions += 1;
      return {
        command: "codex",
        canonicalPath: resolutions === 1 ? "C:\\stale\\codex.cmd" : "C:\\npm\\codex.cmd",
      };
    });

    await provider.probeAuthentication();
    expect((await provider.probeAuthentication()).authentication).toBe("AUTHENTICATED");
    expect(resolutions).toBe(2);
  });
});
