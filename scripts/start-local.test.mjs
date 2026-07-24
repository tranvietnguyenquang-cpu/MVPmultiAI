import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const launcherPath = path.join(here, "start-local.mjs");
const fixturePath = path.join(here, "fixtures", "launcher-fixture.mjs");
const browserFixturePath = path.join(here, "fixtures", "browser-marker-fixture.mjs");

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function fetchOk(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitUntil(predicate, { timeoutMs = 15_000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function fileExists(file) {
  try { await readFile(file, "utf8"); return true; } catch { return false; }
}

function runLauncher(command, env) {
  const child = spawn(process.execPath, [launcherPath, command].filter(Boolean), {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const exit = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  return { child, exit, get stdout() { return stdout; }, get stderr() { return stderr; } };
}

function baseEnv(overrides) {
  return {
    ...process.env,
    PROJECT_RELAY_SKIP_DEPENDENCIES: "true",
    PROJECT_RELAY_OPEN_BROWSER: "false",
    DATABASE_URL: "postgresql://test:test@127.0.0.1:1/test",
    REDIS_URL: "redis://127.0.0.1:1",
    ...overrides,
  };
}

describe("start-local.mjs launcher orchestration", () => {
  const cleanupDirs = [];

  afterAll(async () => {
    await Promise.all(cleanupDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function isolatedEnv(overrides = {}) {
    const runtimeDir = await mkdtemp(path.join(tmpdir(), "project-relay-launcher-test-"));
    cleanupDirs.push(runtimeDir);
    const port = await freePort();
    return {
      port,
      runtimeDir,
      runtimeFile: path.join(runtimeDir, "runtime", "local-processes.json"),
      env: baseEnv({
        PROJECT_RELAY_RUNTIME_DIR: runtimeDir,
        PROJECT_RELAY_WEB_PORT: String(port),
        PROJECT_RELAY_WEB_COMMAND_OVERRIDE: JSON.stringify([process.execPath, [fixturePath, "web"]]),
        PROJECT_RELAY_WORKER_COMMAND_OVERRIDE: JSON.stringify([process.execPath, [fixturePath, "worker"]]),
        ...overrides,
      }),
    };
  }

  it("starts one web and one worker process, becomes healthy, and stop:local releases everything without touching an unrelated sibling", async () => {
    const { port, runtimeFile, env } = await isolatedEnv();
    const sibling = spawn(process.execPath, [fixturePath, "worker"], { stdio: "ignore", windowsHide: true });
    const start = runLauncher("start", env);
    try {
      expect(await waitUntil(() => fetchOk(`http://127.0.0.1:${port}`))).toBe(true);
      // Health and runtime-metadata writing race independently (metadata capture makes
      // several sequential PowerShell calls on Windows); wait for the file directly
      // rather than assuming it exists as soon as the fixture web server is healthy.
      expect(await waitUntil(() => fileExists(runtimeFile))).toBe(true);

      const runtime = JSON.parse(await readFile(runtimeFile, "utf8"));
      expect(runtime.web.pid).toBeGreaterThan(0);
      expect(runtime.worker.pid).toBeGreaterThan(0);
      expect(runtime.web.pid).not.toBe(runtime.worker.pid);
      // Only safe, non-sensitive fields are ever persisted (no DATABASE_URL/REDIS_URL).
      expect(Object.keys(runtime).sort()).toEqual(
        ["launcherPid", "launcherStartIdentity", "ports", "repositoryRoot", "startedAt", "web", "worker"].sort()
      );
      expect(JSON.stringify(runtime)).not.toMatch(/:\/\//);

      const stop = runLauncher("stop", env);
      expect(await stop.exit).toBe(0);

      expect(await fetchOk(`http://127.0.0.1:${port}`)).toBe(false);
      expect(await fileExists(runtimeFile)).toBe(false);
      expect(sibling.exitCode).toBeNull();
    } finally {
      sibling.kill();
      if (start.child.exitCode === null) start.child.kill();
      await start.exit;
    }
  }, 30_000);

  it("a second launcher does not spawn duplicate processes and reports the existing status", async () => {
    const { port, runtimeFile, env } = await isolatedEnv();
    const start = runLauncher("start", env);
    try {
      expect(await waitUntil(() => fetchOk(`http://127.0.0.1:${port}`))).toBe(true);
      expect(await waitUntil(() => fileExists(runtimeFile))).toBe(true);
      const before = JSON.parse(await readFile(runtimeFile, "utf8"));

      const second = runLauncher("start", env);
      expect(await second.exit).toBe(0);
      expect(second.stdout).toMatch(/Web: running/);
      expect(second.stdout).toMatch(/worker: running/);

      const after = JSON.parse(await readFile(runtimeFile, "utf8"));
      expect(after.web.pid).toBe(before.web.pid);
      expect(after.worker.pid).toBe(before.worker.pid);
    } finally {
      const stop = runLauncher("stop", env);
      await stop.exit;
      if (start.child.exitCode === null) start.child.kill();
      await start.exit;
    }
  }, 30_000);

  it("registers SIGINT and SIGTERM handlers that both run the same graceful shutdown path", async () => {
    // node:child_process.kill() on Windows terminates the target via TerminateProcess,
    // which does not invoke the target process's own SIGINT/SIGTERM handlers - only a
    // real console Ctrl+C (or an equivalent in-process signal) does, and that was
    // verified manually in an interactive terminal. This is a structural check that the
    // launcher wires both signals to the same handler, plus an end-to-end check (below)
    // that the system recovers cleanly even in the worst case where the launcher
    // disappears without running that handler at all.
    const source = await readFile(launcherPath, "utf8");
    expect(source).toMatch(/process\.once\("SIGINT",\s*shutdown\)/);
    expect(source).toMatch(/process\.once\("SIGTERM",\s*shutdown\)/);
  });

  it("recovers cleanly if the launcher process disappears without running its own shutdown: a follow-up stop:local cleans up the orphaned children and releases the port", async () => {
    const { port, runtimeFile, env } = await isolatedEnv();
    const start = runLauncher("start", env);
    try {
      expect(await waitUntil(() => fetchOk(`http://127.0.0.1:${port}`))).toBe(true);
      expect(await waitUntil(() => fileExists(runtimeFile))).toBe(true);

      // Simulate the worst case (crash, forced termination) rather than a graceful exit.
      start.child.kill("SIGTERM");
      await start.exit;

      const stop = runLauncher("stop", env);
      expect(await stop.exit).toBe(0);
      expect(await waitUntil(async () => !(await fetchOk(`http://127.0.0.1:${port}`)))).toBe(true);
      expect(await fileExists(runtimeFile)).toBe(false);
    } finally {
      if (start.child.exitCode === null) start.child.kill();
    }
  }, 30_000);

  it("reports worker startup failure clearly and cleans up the web process it owns", async () => {
    const { port, runtimeFile, env } = await isolatedEnv({
      // Give web a startup delay comfortably longer than both the worker's own
      // (deliberately delayed) crash and the launcher's identity-capture time, so the
      // worker crash is always observed before web would otherwise report healthy.
      FIXTURE_DELAY_MS: "4000",
      FIXTURE_WORKER_FAIL: "1",
    });
    const start = runLauncher("start", env);
    expect(await start.exit).toBe(1);
    expect(`${start.stdout}${start.stderr}`.toLowerCase()).toContain("worker exited");
    expect(await fileExists(runtimeFile)).toBe(false);
    expect(await fetchOk(`http://127.0.0.1:${port}`)).toBe(false);
  }, 30_000);

  it("cleans up the owned worker when web fails to become healthy", async () => {
    const { port, runtimeFile, env } = await isolatedEnv({ FIXTURE_WEB_FAIL: "1" });
    const start = runLauncher("start", env);
    expect(await start.exit).toBe(1);
    expect(await fileExists(runtimeFile)).toBe(false);
    expect(await fetchOk(`http://127.0.0.1:${port}`)).toBe(false);
  }, 30_000);

  it("opens the browser at the canonical localhost URL, only after the web health check succeeds", async () => {
    const { port, env } = await isolatedEnv({
      PROJECT_RELAY_OPEN_BROWSER: "true",
      FIXTURE_DELAY_MS: "1200",
      PROJECT_RELAY_BROWSER_COMMAND_OVERRIDE: JSON.stringify([process.execPath, [browserFixturePath]]),
    });
    const markerDir = await mkdtemp(path.join(tmpdir(), "project-relay-marker-"));
    cleanupDirs.push(markerDir);
    const marker = path.join(markerDir, "opened.txt");
    const start = runLauncher("start", { ...env, FIXTURE_MARKER: marker });
    try {
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(await fileExists(marker)).toBe(false);

      expect(await waitUntil(() => fileExists(marker), { timeoutMs: 10_000 })).toBe(true);
      // The browser is opened at "http://localhost:<port>" - the one canonical origin
      // apps/web's same-origin CSRF/session-bootstrap check can match - never the raw
      // "127.0.0.1" bind address, even though the web server still binds there.
      expect(await readFile(marker, "utf8")).toBe(`http://localhost:${port}`);
    } finally {
      const stop = runLauncher("stop", env);
      await stop.exit;
      if (start.child.exitCode === null) start.child.kill();
      await start.exit;
    }
  }, 30_000);

  it("reports status with the canonical localhost URL, not the raw 127.0.0.1 bind address", async () => {
    const { port, runtimeFile, env } = await isolatedEnv();
    const start = runLauncher("start", env);
    try {
      expect(await waitUntil(() => fetchOk(`http://127.0.0.1:${port}`))).toBe(true);
      expect(await waitUntil(() => fileExists(runtimeFile))).toBe(true);
      const status = runLauncher("status", env);
      await status.exit;
      expect(status.stdout).toMatch(/URL: http:\/\/localhost:\d+/);
      expect(status.stdout).not.toContain("URL: http://127.0.0.1");
    } finally {
      const stop = runLauncher("stop", env);
      await stop.exit;
      if (start.child.exitCode === null) start.child.kill();
      await start.exit;
    }
  }, 30_000);
});
