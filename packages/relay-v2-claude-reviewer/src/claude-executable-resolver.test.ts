import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeExecutableResolver, validateNativeClaudeExecutable } from "./claude-executable-resolver.js";

/** A minimal, structurally valid PE image: a 64-byte DOS header ("MZ" at offset 0, e_lfanew=64 at offset 0x3C) immediately followed by the "PE\0\0" signature. Sufficient to pass looksLikeNativePe without needing a real compiled binary. */
function minimalPeBytes(): Buffer {
  const header = Buffer.alloc(64);
  header.write("MZ", 0, "ascii");
  header.writeUInt32LE(64, 0x3c);
  return Buffer.concat([header, Buffer.from("PE\0\0", "ascii"), Buffer.alloc(16)]);
}

describe("ClaudeExecutableResolver", () => {
  let workDir: string | undefined;

  afterEach(async () => {
    if (workDir) await rm(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    workDir = undefined;
  });

  it("prefers RELAY_V2_CLAUDE_PATH when it points at a valid native executable with the expected basename", async () => {
    workDir = await realpath(await mkdtemp(path.join(tmpdir(), "relay-v2-claude-resolver-")));
    const expectedName = process.platform === "win32" ? "claude.exe" : "claude";
    const explicit = path.join(workDir, expectedName);
    await writeFile(explicit, process.platform === "win32" ? minimalPeBytes() : "#!/bin/sh\n");
    const resolver = new ClaudeExecutableResolver({ RELAY_V2_CLAUDE_PATH: explicit });
    expect(await resolver.findExecutable()).toBe(await realpath(explicit));
  });

  it("rejects RELAY_V2_CLAUDE_PATH with an unexpected basename -- an override cannot authorize an arbitrary file", async () => {
    workDir = await realpath(await mkdtemp(path.join(tmpdir(), "relay-v2-claude-resolver-")));
    const explicit = path.join(workDir, "my-claude.exe");
    await writeFile(explicit, minimalPeBytes());
    const resolver = new ClaudeExecutableResolver({ RELAY_V2_CLAUDE_PATH: explicit });
    expect(await resolver.findExecutable()).toBeUndefined();
  });

  it("returns undefined when RELAY_V2_CLAUDE_PATH does not exist -- never falls back silently to a guess", async () => {
    const resolver = new ClaudeExecutableResolver({ RELAY_V2_CLAUDE_PATH: "C:\\does\\not\\exist\\claude.exe" });
    expect(await resolver.findExecutable()).toBeUndefined();
  });

  it("finds claude.exe directly on PATH on win32", async () => {
    if (process.platform !== "win32") return;
    workDir = await realpath(await mkdtemp(path.join(tmpdir(), "relay-v2-claude-resolver-")));
    const exePath = path.join(workDir, "claude.exe");
    await writeFile(exePath, minimalPeBytes());
    const resolver = new ClaudeExecutableResolver({ PATH: workDir });
    expect(await resolver.findExecutable()).toBe(await realpath(exePath));
  });

  it("resolves a Windows npm .cmd shim by parsing its static text, never executing it", async () => {
    if (process.platform !== "win32") return;
    workDir = await realpath(await mkdtemp(path.join(tmpdir(), "relay-v2-claude-resolver-")));
    const binDir = path.join(workDir, "node_modules", "@anthropic-ai", "claude-code", "bin");
    await mkdir(binDir, { recursive: true });
    await writeFile(path.join(binDir, "claude.exe"), minimalPeBytes());
    const shimPath = path.join(workDir, "claude.cmd");
    await writeFile(shimPath, "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe\"   %*\r\n");
    const resolver = new ClaudeExecutableResolver({ PATH: workDir });
    expect(await resolver.findExecutable()).toBe(await realpath(path.join(binDir, "claude.exe")));
  });

  it("never resolves a shim whose referenced target does not actually exist on disk", async () => {
    if (process.platform !== "win32") return;
    workDir = await realpath(await mkdtemp(path.join(tmpdir(), "relay-v2-claude-resolver-")));
    const shimPath = path.join(workDir, "claude.cmd");
    await writeFile(shimPath, "\"%~dp0\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe\"   %*\n");
    const resolver = new ClaudeExecutableResolver({ PATH: workDir });
    expect(await resolver.findExecutable()).toBeUndefined();
  });

  it("never resolves a shim whose target exists but is not a valid native PE image", async () => {
    if (process.platform !== "win32") return;
    workDir = await realpath(await mkdtemp(path.join(tmpdir(), "relay-v2-claude-resolver-")));
    const binDir = path.join(workDir, "node_modules", "@anthropic-ai", "claude-code", "bin");
    await mkdir(binDir, { recursive: true });
    await writeFile(path.join(binDir, "claude.exe"), "not a real PE binary, just text");
    const shimPath = path.join(workDir, "claude.cmd");
    await writeFile(shimPath, "\"%~dp0\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe\"   %*\n");
    const resolver = new ClaudeExecutableResolver({ PATH: workDir });
    expect(await resolver.findExecutable()).toBeUndefined();
  });

  it("returns undefined when PATH has no matching executable or shim at all", async () => {
    workDir = await realpath(await mkdtemp(path.join(tmpdir(), "relay-v2-claude-resolver-")));
    const resolver = new ClaudeExecutableResolver({ PATH: workDir });
    expect(await resolver.findExecutable()).toBeUndefined();
  });
});

describe("validateNativeClaudeExecutable", () => {
  let workDir: string | undefined;

  afterEach(async () => {
    if (workDir) await rm(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    workDir = undefined;
  });

  it("accepts a native claude.exe with a valid PE header on win32", async () => {
    if (process.platform !== "win32") return;
    workDir = await realpath(await mkdtemp(path.join(tmpdir(), "relay-v2-claude-validate-")));
    const exePath = path.join(workDir, "claude.exe");
    await writeFile(exePath, minimalPeBytes());
    expect(await validateNativeClaudeExecutable(exePath)).toMatchObject({ ok: true });
  });

  it("rejects a .cmd file even if it happens to also be named claude.exe.cmd or similar", async () => {
    workDir = await realpath(await mkdtemp(path.join(tmpdir(), "relay-v2-claude-validate-")));
    const cmdPath = path.join(workDir, "claude.cmd");
    await writeFile(cmdPath, "@ECHO off\r\n");
    expect(await validateNativeClaudeExecutable(cmdPath)).toMatchObject({ ok: false, reason: "FORBIDDEN_EXTENSION" });
  });

  it("rejects a .ps1 file", async () => {
    workDir = await realpath(await mkdtemp(path.join(tmpdir(), "relay-v2-claude-validate-")));
    const psPath = path.join(workDir, "claude.ps1");
    await writeFile(psPath, "Write-Output 'hi'");
    expect(await validateNativeClaudeExecutable(psPath)).toMatchObject({ ok: false, reason: "FORBIDDEN_EXTENSION" });
  });

  it("rejects a directory even if named claude.exe", async () => {
    workDir = await realpath(await mkdtemp(path.join(tmpdir(), "relay-v2-claude-validate-")));
    const dirPath = path.join(workDir, process.platform === "win32" ? "claude.exe" : "claude");
    await mkdir(dirPath);
    expect(await validateNativeClaudeExecutable(dirPath)).toMatchObject({ ok: false, reason: "NOT_A_REGULAR_FILE" });
  });

  it("rejects an arbitrary .exe whose header is not a valid PE image on win32", async () => {
    if (process.platform !== "win32") return;
    workDir = await realpath(await mkdtemp(path.join(tmpdir(), "relay-v2-claude-validate-")));
    const exePath = path.join(workDir, "claude.exe");
    await writeFile(exePath, "this is just a text file pretending to be an exe, well past 64 bytes of padding content");
    expect(await validateNativeClaudeExecutable(exePath)).toMatchObject({ ok: false, reason: "MALFORMED_PE" });
  });

  it("rejects a malformed/truncated PE header (too short to contain e_lfanew)", async () => {
    if (process.platform !== "win32") return;
    workDir = await realpath(await mkdtemp(path.join(tmpdir(), "relay-v2-claude-validate-")));
    const exePath = path.join(workDir, "claude.exe");
    await writeFile(exePath, Buffer.from("MZ"));
    expect(await validateNativeClaudeExecutable(exePath)).toMatchObject({ ok: false, reason: "MALFORMED_PE" });
  });

  it("rejects a relative path", async () => {
    expect(await validateNativeClaudeExecutable("claude.exe")).toMatchObject({ ok: false, reason: "NOT_ABSOLUTE" });
  });

  it("rejects a path that does not exist", async () => {
    expect(await validateNativeClaudeExecutable(path.join(tmpdir(), "definitely-does-not-exist-claude.exe"))).toMatchObject({ ok: false, reason: "NOT_FOUND" });
  });

  it("rejects an empty file", async () => {
    workDir = await realpath(await mkdtemp(path.join(tmpdir(), "relay-v2-claude-validate-")));
    const exePath = path.join(workDir, process.platform === "win32" ? "claude.exe" : "claude");
    await writeFile(exePath, "");
    expect(await validateNativeClaudeExecutable(exePath)).toMatchObject({ ok: false, reason: "EMPTY_FILE" });
  });

  it("accepts a valid native executable reached through a symlink, validating the resolved target", async () => {
    // Mirrors a real npm global install's layout: a symlink at one path
    // (e.g. a PATH bin directory) pointing at the real binary elsewhere,
    // both sharing the same basename -- validation applies to the resolved
    // (realpath'd) target, not the link's own path.
    workDir = await realpath(await mkdtemp(path.join(tmpdir(), "relay-v2-claude-validate-")));
    const expectedName = process.platform === "win32" ? "claude.exe" : "claude";
    const realDir = path.join(workDir, "real-install");
    await mkdir(realDir, { recursive: true });
    const realTarget = path.join(realDir, expectedName);
    await writeFile(realTarget, process.platform === "win32" ? minimalPeBytes() : "#!/bin/sh\n");
    const linkDir = path.join(workDir, "bin");
    await mkdir(linkDir, { recursive: true });
    const linkPath = path.join(linkDir, expectedName);
    try {
      await (await import("node:fs/promises")).symlink(realTarget, linkPath);
    } catch {
      return; // Symlink creation can require elevated privileges on Windows; skip if unavailable.
    }
    expect(await validateNativeClaudeExecutable(linkPath)).toMatchObject({ ok: true, realPath: await realpath(realTarget) });
  });

  it("handles Unicode and spaces in a valid native path", async () => {
    workDir = await realpath(await mkdtemp(path.join(tmpdir(), "relay-v2-claude-validate-\u00e9-")));
    const nestedDir = path.join(workDir, "My Cömpany Tools");
    await mkdir(nestedDir, { recursive: true });
    const expectedName = process.platform === "win32" ? "claude.exe" : "claude";
    const exePath = path.join(nestedDir, expectedName);
    await writeFile(exePath, process.platform === "win32" ? minimalPeBytes() : "#!/bin/sh\n");
    expect(await validateNativeClaudeExecutable(exePath)).toMatchObject({ ok: true });
  });
});
