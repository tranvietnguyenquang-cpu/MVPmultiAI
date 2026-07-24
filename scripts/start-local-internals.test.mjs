import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(here, "fixtures", "launcher-fixture.mjs");

let mod;
let runtimeDir;

async function holdPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ port: server.address().port, server }));
  });
}

async function waitUntil(predicate, { timeoutMs = 5000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

beforeAll(async () => {
  runtimeDir = await mkdtemp(path.join(tmpdir(), "project-relay-internals-test-"));
  process.env.PROJECT_RELAY_RUNTIME_DIR = runtimeDir;
  mod = await import("./start-local.mjs");
});

afterAll(async () => {
  delete process.env.PROJECT_RELAY_RUNTIME_DIR;
  await rm(runtimeDir, { recursive: true, force: true });
});

describe("resolveServicePort", () => {
  it("refuses a configured, non-default port occupied by an unrelated process and never touches it", async () => {
    const occupied = await holdPort();
    process.env.TEST_A_URL = `postgresql://x:y@127.0.0.1:${occupied.port}/db`;
    try {
      await expect(mod.resolveServicePort({
        label: "PostgreSQL", urlEnvVar: "TEST_A_URL", portEnvVar: "TEST_A_PORT",
        defaultPort: 55000, legacyPort: 54999, running: false,
      })).rejects.toThrow(/in use by an unverified process/);
      expect(occupied.server.listening).toBe(true);
    } finally {
      occupied.server.close();
      delete process.env.TEST_A_URL;
      delete process.env.TEST_A_PORT;
    }
  });

  it("falls back from the legacy default port to the dedicated MVPmultiAI port, without touching the occupier", async () => {
    const legacy = await holdPort();
    const dedicated = await holdPort();
    const dedicatedPort = dedicated.port;
    await new Promise((resolve) => dedicated.server.close(resolve)); // free it up for the launcher to claim
    process.env.TEST_B_URL = `redis://127.0.0.1:${legacy.port}`;
    try {
      const resolved = await mod.resolveServicePort({
        label: "Redis", urlEnvVar: "TEST_B_URL", portEnvVar: "TEST_B_PORT",
        defaultPort: dedicatedPort, legacyPort: legacy.port, running: false,
      });
      expect(resolved).toBe(dedicatedPort);
      expect(process.env.TEST_B_PORT).toBe(String(dedicatedPort));
      expect(process.env.TEST_B_URL).toContain(`:${dedicatedPort}`);
      expect(legacy.server.listening).toBe(true);
    } finally {
      legacy.server.close();
      delete process.env.TEST_B_URL;
      delete process.env.TEST_B_PORT;
    }
  });

  it("reuses the configured port without probing it when the service is already known to be running", async () => {
    const occupied = await holdPort();
    process.env.TEST_C_URL = `redis://127.0.0.1:${occupied.port}`;
    try {
      const resolved = await mod.resolveServicePort({
        label: "Redis", urlEnvVar: "TEST_C_URL", portEnvVar: "TEST_C_PORT",
        defaultPort: 6380, legacyPort: 6379, running: true,
      });
      expect(resolved).toBe(occupied.port);
    } finally {
      occupied.server.close();
      delete process.env.TEST_C_URL;
      delete process.env.TEST_C_PORT;
    }
  });
});

describe("terminateRecorded (PID-reuse protection)", () => {
  it("refuses to terminate a live process when the recorded start identity does not match, and terminates it once the identity is correct", async () => {
    const child = spawn(process.execPath, [fixturePath, "worker"], { stdio: "ignore", windowsHide: true });
    try {
      await waitUntil(async () => Boolean(await mod.processIdentity(child.pid)));
      const realIdentity = await mod.processIdentity(child.pid);

      const mismatchResult = await mod.terminateRecorded({ pid: child.pid, startIdentity: "not-the-real-start-time" });
      expect(mismatchResult).toBe("identity-mismatch");
      expect(await mod.processIdentity(child.pid)).toBeTruthy();

      const result = await mod.terminateRecorded({ pid: child.pid, startIdentity: realIdentity });
      expect(result).toBe("terminated");
      expect(await mod.processIdentity(child.pid)).toBeFalsy();
    } finally {
      child.kill();
    }
  }, 15_000);

  it("reports already-exited for a process that has already stopped", async () => {
    const child = spawn(process.execPath, [fixturePath, "worker"], {
      stdio: "ignore", windowsHide: true, env: { ...process.env, FIXTURE_WORKER_FAIL: "1" },
    });
    // Register the exit listener before any await: the fixture can exit within
    // milliseconds, and a listener attached after an async gap can miss the event.
    const exited = new Promise((resolve) => child.once("exit", resolve));
    const identity = await mod.processIdentity(child.pid).catch(() => undefined);
    await exited;
    expect(await mod.terminateRecorded({ pid: child.pid, startIdentity: identity ?? "whatever" })).toBe("already-exited");
  }, 10_000);
});

describe("removeStaleRuntime", () => {
  it("removes metadata once a mismatched/exited launcher PID is proven, but preserves metadata for a verified live launcher", async () => {
    const exited = spawn(process.execPath, [fixturePath, "worker"], {
      stdio: "ignore", windowsHide: true, env: { ...process.env, FIXTURE_WORKER_FAIL: "1" },
    });
    const exitedDone = new Promise((resolve) => exited.once("exit", resolve));
    await exitedDone;
    await mod.writeRuntime({
      launcherPid: exited.pid, launcherStartIdentity: "stale-identity",
      web: { pid: 1, startIdentity: "x" }, worker: { pid: 2, startIdentity: "y" },
      startedAt: new Date().toISOString(), ports: [3000], repositoryRoot: "C:\\MVPmultiAI",
    });
    expect(await mod.removeStaleRuntime()).toBeUndefined();
    await expect(readFile(mod.runtimeFile, "utf8")).rejects.toThrow();

    const alive = spawn(process.execPath, [fixturePath, "worker"], { stdio: "ignore", windowsHide: true });
    try {
      await waitUntil(async () => Boolean(await mod.processIdentity(alive.pid)));
      const identity = await mod.processIdentity(alive.pid);
      await mod.writeRuntime({
        launcherPid: alive.pid, launcherStartIdentity: identity,
        web: { pid: 1, startIdentity: "x" }, worker: { pid: 2, startIdentity: "y" },
        startedAt: new Date().toISOString(), ports: [3000], repositoryRoot: "C:\\MVPmultiAI",
      });
      const saved = await mod.removeStaleRuntime();
      expect(saved?.launcherPid).toBe(alive.pid);
      expect(await readFile(mod.runtimeFile, "utf8")).toBeTruthy();
    } finally {
      alive.kill();
    }
  }, 15_000);

  it("cleans up orphaned web/worker processes left behind by a launcher that died without running its own shutdown path", async () => {
    const exitedLauncher = spawn(process.execPath, [fixturePath, "worker"], {
      stdio: "ignore", windowsHide: true, env: { ...process.env, FIXTURE_WORKER_FAIL: "1" },
    });
    const launcherExited = new Promise((resolve) => exitedLauncher.once("exit", resolve));
    await launcherExited;

    const web = spawn(process.execPath, [fixturePath, "worker"], { stdio: "ignore", windowsHide: true });
    const worker = spawn(process.execPath, [fixturePath, "worker"], { stdio: "ignore", windowsHide: true });
    try {
      await waitUntil(async () => Boolean(await mod.processIdentity(web.pid)) && Boolean(await mod.processIdentity(worker.pid)));
      await mod.writeRuntime({
        launcherPid: exitedLauncher.pid, launcherStartIdentity: "stale-identity",
        web: { pid: web.pid, startIdentity: await mod.processIdentity(web.pid) },
        worker: { pid: worker.pid, startIdentity: await mod.processIdentity(worker.pid) },
        startedAt: new Date().toISOString(), ports: [3000], repositoryRoot: "C:\\MVPmultiAI",
      });

      expect(await mod.removeStaleRuntime()).toBeUndefined();
      expect(await mod.processIdentity(web.pid)).toBeFalsy();
      expect(await mod.processIdentity(worker.pid)).toBeFalsy();
      await expect(readFile(mod.runtimeFile, "utf8")).rejects.toThrow();
    } finally {
      web.kill();
      worker.kill();
    }
  }, 30_000);
});

describe("safeText", () => {
  it("redacts connection strings and credential-shaped values", () => {
    const text = mod.safeText("Connecting to postgresql://user:sup3rsecret@127.0.0.1:5434/projectrelay and redis://:pw@127.0.0.1:6380");
    expect(text).not.toContain("sup3rsecret");
    expect(text).not.toContain("pw@127.0.0.1:6380");
    expect(text).toContain("[redacted]");
    expect(mod.safeText("token=abc123def")).not.toContain("abc123def");
  });
});

describe("db:generate is never invoked by the launcher while web/worker are active", () => {
  it("contains no execFile/spawn invocation of db:generate", async () => {
    const source = await readFile(path.join(here, "start-local.mjs"), "utf8");
    expect(source).not.toMatch(/\[\s*"run"\s*,\s*"db:generate"\s*\]/);
  });

  it("package.json defines no predev:local hook that would auto-run db:generate", async () => {
    const pkg = JSON.parse(await readFile(path.join(here, "..", "package.json"), "utf8"));
    expect(pkg.scripts["predev:local"]).toBeUndefined();
  });
});
