// Windows process-tree regression tests for the launcher's real-child-ownership fix.
// These use harmless Node fixtures (never real provider/dev processes) to simulate the
// exact shape of the confirmed defect: an intermediate wrapper process - standing in for
// the cmd.exe/npm-cli.js chain `npm run dev:web` produces on Windows - that spawns the
// real long-lived process and exits on its own before that real process does.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import * as mod from "./start-local.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const launcherPath = path.join(here, "start-local.mjs");
const fixturePath = path.join(here, "fixtures", "launcher-fixture.mjs");
const wrapperFixturePath = path.join(here, "fixtures", "wrapper-fixture.mjs");
const isWindows = process.platform === "win32";

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

const describeWindows = isWindows ? describe : describe.skip;

describeWindows("launcher Windows process-tree ownership", () => {
  const cleanupDirs = [];
  const strayPids = [];

  afterAll(async () => {
    for (const pid of strayPids) { try { process.kill(pid); } catch { /* already gone */ } }
    await Promise.all(cleanupDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function isolatedEnv(overrides = {}) {
    const runtimeDir = await mkdtemp(path.join(tmpdir(), "project-relay-tree-test-"));
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

  it("tracks the real descendant once an intermediate wrapper exits, and stop:local terminates the real web/worker trees (port released, sibling untouched)", async () => {
    const { port, runtimeFile, env } = await isolatedEnv({
      PROJECT_RELAY_WEB_COMMAND_OVERRIDE: JSON.stringify([process.execPath, [wrapperFixturePath, "web"]]),
      PROJECT_RELAY_WORKER_COMMAND_OVERRIDE: JSON.stringify([process.execPath, [wrapperFixturePath, "worker"]]),
      FIXTURE_WRAPPER_EXIT_DELAY_MS: "3000",
      FIXTURE_WRAPPER_DETACHED: "1",
    });
    const sibling = spawn(process.execPath, [fixturePath, "worker"], { stdio: "ignore", windowsHide: true });
    const start = runLauncher("start", env);
    try {
      expect(await waitUntil(() => fetchOk(`http://127.0.0.1:${port}`))).toBe(true);
      expect(await waitUntil(() => fileExists(runtimeFile))).toBe(true);
      const initial = JSON.parse(await readFile(runtimeFile, "utf8"));
      expect(await mod.processIdentity(initial.web.pid)).toBeTruthy();
      expect(await mod.processIdentity(initial.worker.pid)).toBeTruthy();

      // The wrapper exits on its own; the real descendant (launcher-fixture) keeps running.
      expect(await waitUntil(async () => !(await mod.processIdentity(initial.web.pid)))).toBe(true);
      expect(await waitUntil(async () => !(await mod.processIdentity(initial.worker.pid)))).toBe(true);
      expect(await fetchOk(`http://127.0.0.1:${port}`)).toBe(true); // real web descendant is still serving

      // A fresh status:local invocation must adopt and report the real descendant as running.
      const status = runLauncher("status", env);
      expect(await status.exit).toBe(0);
      expect(status.stdout).toMatch(/Web: running/);
      expect(status.stdout).toMatch(/worker: running/);

      const adopted = JSON.parse(await readFile(runtimeFile, "utf8"));
      expect(adopted.web.pid).not.toBe(initial.web.pid);
      expect(adopted.worker.pid).not.toBe(initial.worker.pid);
      expect(adopted.web.adoptedFromPid).toBe(initial.web.pid);
      expect(adopted.worker.adoptedFromPid).toBe(initial.worker.pid);
      expect(await mod.processIdentity(adopted.web.pid)).toBeTruthy();
      expect(await mod.processIdentity(adopted.worker.pid)).toBeTruthy();

      const stop = runLauncher("stop", env);
      expect(await stop.exit).toBe(0);

      expect(await waitUntil(async () => !(await mod.processIdentity(adopted.web.pid)))).toBe(true);
      expect(await mod.processIdentity(adopted.worker.pid)).toBeFalsy();
      expect(await fetchOk(`http://127.0.0.1:${port}`)).toBe(false);
      expect(await fileExists(runtimeFile)).toBe(false);
      expect(sibling.exitCode).toBeNull();
    } finally {
      sibling.kill();
      if (start.child.exitCode === null) start.child.kill();
      await start.exit;
    }
  }, 30_000);

  it("reconciles a real descendant left behind by a launcher that crashed after its wrapper had already exited", async () => {
    const { port, runtimeFile, env } = await isolatedEnv({
      PROJECT_RELAY_WEB_COMMAND_OVERRIDE: JSON.stringify([process.execPath, [wrapperFixturePath, "web"]]),
      PROJECT_RELAY_WORKER_COMMAND_OVERRIDE: JSON.stringify([process.execPath, [wrapperFixturePath, "worker"]]),
      FIXTURE_WRAPPER_EXIT_DELAY_MS: "3000",
      FIXTURE_WRAPPER_DETACHED: "1",
    });
    const start = runLauncher("start", env);
    try {
      expect(await waitUntil(() => fetchOk(`http://127.0.0.1:${port}`))).toBe(true);
      expect(await waitUntil(() => fileExists(runtimeFile))).toBe(true);
      const initial = JSON.parse(await readFile(runtimeFile, "utf8"));
      expect(await waitUntil(async () => !(await mod.processIdentity(initial.web.pid)))).toBe(true);

      // Worst case: the launcher itself disappears without running its own shutdown,
      // on top of the wrapper having already exited underneath it.
      start.child.kill("SIGKILL");
      await start.exit;

      const stop = runLauncher("stop", env); // a fresh invocation, as after a restart
      expect(await stop.exit).toBe(0);
      expect(await waitUntil(async () => !(await fetchOk(`http://127.0.0.1:${port}`)))).toBe(true);
      expect(await fileExists(runtimeFile)).toBe(false);
    } finally {
      if (start.child.exitCode === null) start.child.kill();
    }
  }, 30_000);

  it("refuses to adopt when more than one live descendant matches: fails closed, terminates nothing, reports the conflict", async () => {
    const { port, runtimeFile, env } = await isolatedEnv({
      PROJECT_RELAY_WORKER_COMMAND_OVERRIDE: JSON.stringify([process.execPath, [wrapperFixturePath, "worker"]]),
      FIXTURE_WRAPPER_CHILDREN: "2",
      FIXTURE_WRAPPER_EXIT_DELAY_MS: "3000",
      FIXTURE_WRAPPER_DETACHED: "1",
    });
    const start = runLauncher("start", env);
    try {
      expect(await waitUntil(() => fetchOk(`http://127.0.0.1:${port}`))).toBe(true);
      expect(await waitUntil(() => fileExists(runtimeFile))).toBe(true);
      const initial = JSON.parse(await readFile(runtimeFile, "utf8"));
      expect(await waitUntil(async () => !(await mod.processIdentity(initial.worker.pid)))).toBe(true);

      const status = runLauncher("status", env);
      expect(await status.exit).toBe(0);
      expect(status.stdout.toLowerCase()).toContain("ambiguous");

      // Metadata is left exactly as it was - still pointing at the dead wrapper PID -
      // rather than guessing which candidate to adopt.
      const after = JSON.parse(await readFile(runtimeFile, "utf8"));
      expect(after.worker.pid).toBe(initial.worker.pid);

      const stop = runLauncher("stop", env);
      expect(await stop.exit).toBe(0);
      expect(stop.stdout.toLowerCase()).toContain("ambiguous");
      expect(await fileExists(runtimeFile)).toBe(true); // refused to delete/modify

      // Both ambiguous candidates must still be alive - neither was guessed-and-killed.
      const snapshot = await mod.windowsProcessSnapshot();
      const resolved = mod.selectDescendant(snapshot, initial.worker);
      expect(resolved.status).toBe("ambiguous");
      for (const candidate of resolved.candidates) {
        expect(await mod.processIdentity(candidate.pid)).toBeTruthy();
        strayPids.push(candidate.pid); // clean up directly; the launcher correctly won't
      }
    } finally {
      if (start.child.exitCode === null) start.child.kill();
      await start.exit;
    }
  }, 30_000);

  it("Status-MVPmultiAI.cmd and Stop-MVPmultiAI.cmd still work when invoked from a different working directory", async () => {
    const { env } = await isolatedEnv();
    const elsewhere = await mkdtemp(path.join(tmpdir(), "project-relay-elsewhere-"));
    cleanupDirs.push(elsewhere);

    function runCmd(cmdFile) {
      return new Promise((resolve) => {
        const child = spawn("cmd.exe", ["/c", cmdFile], { cwd: elsewhere, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
        child.once("exit", (code) => resolve({ code, stdout }));
      });
    }

    const status = await runCmd(path.join(root, "Status-MVPmultiAI.cmd"));
    expect(status.code).toBe(0);
    expect(status.stdout).toMatch(/Web: stopped/);

    const stop = await runCmd(path.join(root, "Stop-MVPmultiAI.cmd"));
    expect(stop.code).toBe(0);
    expect(stop.stdout).toMatch(/No verified local launcher metadata found/);
  }, 20_000);
});

describe("selectDescendant (pure ownership resolution)", () => {
  const startIdentity = "2026-01-01T00:00:00.0000000Z";

  it("adopts the single verified descendant created at/after the dead record's own start time", () => {
    const record = { pid: 111, startIdentity };
    const snapshot = [
      { pid: 222, parentPid: 111, commandLine: `"node.exe" "${root}\\node_modules\\next\\dist\\bin\\next" dev`, creationDate: "2026-01-01T00:00:01.0000000Z" },
    ];
    const result = mod.selectDescendant(snapshot, record);
    expect(result.status).toBe("adopted");
    expect(result.record.pid).toBe(222);
    expect(result.record.adoptedFromPid).toBe(111);
  });

  it("refuses a candidate created before the dead record's own recorded start (protects against PID reuse)", () => {
    const record = { pid: 111, startIdentity };
    const snapshot = [
      { pid: 222, parentPid: 111, commandLine: `"node.exe" "${root}\\node_modules\\next\\dist\\bin\\next" dev`, creationDate: "2025-12-31T23:59:59.0000000Z" },
    ];
    expect(mod.selectDescendant(snapshot, record).status).toBe("gone");
  });

  it("refuses a candidate whose command line/path does not name this repository, even if ancestry matches", () => {
    const record = { pid: 111, startIdentity };
    const snapshot = [
      { pid: 222, parentPid: 111, commandLine: "\"node.exe\" C:\\SomeOtherApp\\server.js", creationDate: "2026-01-01T00:00:01.0000000Z" },
    ];
    expect(mod.selectDescendant(snapshot, record).status).toBe("gone");
  });

  it("reports ambiguous when more than one live candidate matches, and adopts neither", () => {
    const record = { pid: 111, startIdentity };
    const snapshot = [
      { pid: 222, parentPid: 111, commandLine: `"node.exe" "${root}\\node_modules\\tsx\\dist\\cli.mjs" watch`, creationDate: "2026-01-01T00:00:01.0000000Z" },
      { pid: 333, parentPid: 111, commandLine: `"node.exe" "${root}\\node_modules\\tsx\\dist\\cli.mjs" watch`, creationDate: "2026-01-01T00:00:02.0000000Z" },
    ];
    const result = mod.selectDescendant(snapshot, record);
    expect(result.status).toBe("ambiguous");
    expect(result.candidates.map((c) => c.pid).sort()).toEqual([222, 333]);
  });

  it("reports gone when a dead record has no live descendant at all", () => {
    expect(mod.selectDescendant([], { pid: 111, startIdentity }).status).toBe("gone");
  });
});
