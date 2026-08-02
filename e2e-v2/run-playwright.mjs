/* global fetch, process, setTimeout */
import { spawn } from "node:child_process";
import path from "node:path";

const port = process.env.PROJECT_RELAY_V2_E2E_PORT ?? "3400";
const baseURL = `http://localhost:${port}`;
const dataDir = path.resolve(process.cwd(), ".relay-data", "playwright-v2");
const environment = {
  ...process.env,
  PORT: port,
  PROJECT_RELAY_BIND_HOST: "127.0.0.1",
  PROJECT_RELAY_TEST_MODE: "true",
  RELAY_V2_ENABLED: "true",
  RELAY_V2_DATA_DIR: dataDir,
  RELAY_V2_E2E_DATA_DIR: dataDir,
  RELAY_V2_DATABASE_URL: `file:${path.join(dataDir, "relay-v2.db").replace(/\\/g, "/")}`,
  DATABASE_URL: "postgresql://relay:relay@127.0.0.1:59999/projectrelay_e2e_v2",
  REDIS_URL: "redis://127.0.0.1:56379/15"
};

const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "apps/web", "--hostname", "127.0.0.1", "--port", port], {
  cwd: process.cwd(),
  env: environment,
  stdio: "inherit",
  windowsHide: true
});

async function waitForServer() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Next server exited with code ${server.exitCode}.`);
    try {
      const response = await fetch(`${baseURL}/v2`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for the Relay v2 browser test server.");
}

async function stopOwnedProcess(child) {
  if (child.exitCode !== null) return;
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref();
  if (process.platform === "win32" && child.pid) {
    const killer = spawn(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
    killer.unref();
  } else {
    child.kill("SIGTERM");
  }
}

let exitCode = 1;
try {
  await waitForServer();
  exitCode = await new Promise((resolve, reject) => {
    const runner = spawn(process.execPath, ["node_modules/@playwright/test/cli.js", "test", "--config", "playwright.v2.config.ts"], {
      cwd: process.cwd(),
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let summary = "";
    let settled = false;
    const finish = async code => {
      if (settled) return;
      settled = true;
      await stopOwnedProcess(runner);
      resolve(code);
    };
    const observe = (chunk, destination) => {
      destination.write(chunk);
      summary = `${summary}${chunk.toString()}`.slice(-8_000);
      if (/\b\d+ failed\b/.test(summary)) void finish(1);
      else if (/\b\d+ passed \([^)]+\)/.test(summary)) void finish(0);
    };
    runner.stdout.on("data", chunk => observe(chunk, process.stdout));
    runner.stderr.on("data", chunk => observe(chunk, process.stderr));
    runner.once("error", reject);
    runner.once("exit", code => { if (!settled) resolve(code ?? 1); });
  });
} finally {
  await stopOwnedProcess(server);
}
process.exitCode = exitCode;
