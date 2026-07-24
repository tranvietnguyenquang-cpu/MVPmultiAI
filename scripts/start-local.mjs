import { spawn, execFile as execFileCallback, exec as execCallback } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, readFile, rm, stat, writeFile, appendFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const exec = promisify(execCallback);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Overridable only for tests, so a test run never touches a real dev session's runtime
// metadata/logs. Unset in normal use: behavior is unchanged.
const stateRoot = process.env.PROJECT_RELAY_RUNTIME_DIR ? path.resolve(process.env.PROJECT_RELAY_RUNTIME_DIR) : path.join(root, ".project-relay");
const runtimeDir = path.join(stateRoot, "runtime");
export const runtimeFile = path.join(runtimeDir, "local-processes.json");
const logDir = path.join(stateRoot, "logs");
export const webPort = Number(process.env.PROJECT_RELAY_WEB_PORT || 3000);
export const url = `http://127.0.0.1:${webPort}`;
const isWindows = process.platform === "win32";

function out(prefix, message) { console.log(`[${prefix}] ${message}`); }
export function safeText(value) {
  return String(value).replace(/(?:postgres(?:ql)?:\/\/|redis:\/\/)[^\s]+|(?:token|secret|password|cookie)=\S+/gi, "[redacted]");
}
function assertRepository() {
  if (!path.basename(root) || !process.cwd().startsWith(root) && !root.startsWith(process.cwd())) {
    throw new Error("Local launcher must run from the MVPmultiAI repository.");
  }
}
async function loadLocalEnvironment() {
  const text = await readFile(path.join(root, ".env"), "utf8").catch(() => "");
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(?:"([\s\S]*)"|'([\s\S]*)'|(.*))$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2] ?? match[3] ?? match[4] ?? "";
  }
}
export async function processIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (isWindows) {
    try {
      const { stdout } = await execFile("powershell.exe", ["-NoProfile", "-Command", `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('O')`], { windowsHide: true });
      return stdout.trim() || undefined;
    } catch { return undefined; }
  }
  try { process.kill(pid, 0); return "present"; } catch { return undefined; }
}
const rootLower = root.toLowerCase();
// A descendant is only ever considered "ours" if its command line or executable path
// names this repository - ancestry (parentPid) alone is not trusted as sufficient proof,
// since a dead PID can in principle be reused by something unrelated.
function withinRepository(candidate) {
  return (candidate.commandLine || "").toLowerCase().includes(rootLower) || (candidate.executablePath || "").toLowerCase().includes(rootLower);
}
// One snapshot of every live Windows process, used to look for a verified descendant
// once a recorded PID (e.g. an intermediate wrapper) turns out to be dead. CreationDate
// is normalized to the same ISO-8601 UTC format `processIdentity` uses for StartTime, so
// the two are directly comparable.
export async function windowsProcessSnapshot() {
  if (!isWindows) return [];
  try {
    const script = "@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine,ExecutablePath,@{N='CreationDate';E={ if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null } }}) | ConvertTo-Json -Compress -Depth 3";
    const { stdout } = await execFile("powershell.exe", ["-NoProfile", "-Command", script], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    const rows = JSON.parse(stdout.trim() || "[]");
    return (Array.isArray(rows) ? rows : [rows]).map((row) => ({
      pid: row.ProcessId, parentPid: row.ParentProcessId,
      commandLine: row.CommandLine || "", executablePath: row.ExecutablePath || "",
      creationDate: row.CreationDate || undefined,
    }));
  } catch { return []; }
}
// Pure (no I/O) so PID-reuse and ambiguity handling can be unit-tested with a synthetic
// snapshot instead of racing real Windows process creation/reuse timing.
export function selectDescendant(snapshot, record) {
  if (!record?.pid) return { status: "gone" };
  const candidates = snapshot.filter((p) =>
    p.parentPid === record.pid &&
    withinRepository(p) &&
    // Never adopt a process that existed before the (now-dead) recorded process did -
    // that would be a reused PID coincidentally parenting something unrelated, not our
    // own descendant.
    (!record.startIdentity || !p.creationDate || p.creationDate >= record.startIdentity)
  );
  if (candidates.length === 0) return { status: "gone" };
  if (candidates.length > 1) return { status: "ambiguous", candidates };
  const winner = candidates[0];
  return { status: "adopted", record: { pid: winner.pid, startIdentity: winner.creationDate, adoptedFromPid: record.pid } };
}
// Resolves what a recorded web/worker entry actually refers to right now: the recorded
// PID itself if it is still alive and identity-matched (the common case); otherwise, on
// Windows only, a search for the one verified live descendant it left behind (see
// selectDescendant). snapshotCache is a `{ value }` box shared across both the web and
// worker lookups in a single reconcile pass, so the (comparatively slow) process
// snapshot is only ever fetched once, and only when actually needed.
async function resolveRecord(record, snapshotCache) {
  if (!record?.pid) return { status: "not-recorded" };
  const identity = await processIdentity(record.pid);
  if (identity && identity === record.startIdentity) return { status: "live", record };
  if (!isWindows) return { status: "gone" };
  if (!snapshotCache.value) snapshotCache.value = await windowsProcessSnapshot();
  const result = selectDescendant(snapshotCache.value, record);
  if (result.status !== "adopted") return result;
  // CIM's CreationDate (used to pick the candidate) and Get-Process's StartTime (used by
  // every future processIdentity() check) can disagree at sub-millisecond precision for
  // the very same process. Re-derive the adopted record's startIdentity from
  // processIdentity itself, or the freshly adopted PID would look like a mismatch the
  // moment it's checked again.
  const confirmedIdentity = await processIdentity(result.record.pid);
  if (!confirmedIdentity) return { status: "gone" };
  return { status: "adopted", record: { ...result.record, startIdentity: confirmedIdentity } };
}
async function readRuntime() {
  try { return JSON.parse(await readFile(runtimeFile, "utf8")); } catch { return undefined; }
}
export async function writeRuntime(data) {
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(runtimeFile, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
}
export async function removeStaleRuntime() {
  const saved = await readRuntime();
  if (!saved) return undefined;
  const launcher = await processIdentity(saved.launcherPid);
  const launcherAlive = Boolean(launcher && launcher === saved.launcherStartIdentity);
  // Re-verify web/worker independently of the launcher: even a live launcher's own child
  // handle can be an intermediate wrapper that has since exited while the real process it
  // spawned kept running (see selectDescendant). Shared snapshotCache so both lookups
  // together cost at most one process snapshot.
  const snapshotCache = {};
  const web = await resolveRecord(saved.web, snapshotCache);
  const worker = await resolveRecord(saved.worker, snapshotCache);
  if (web.status === "ambiguous" || worker.status === "ambiguous") {
    const describe = (result, role) => result.status === "ambiguous" ? `${role} ownership is ambiguous among PIDs [${result.candidates.map((c) => c.pid).join(", ")}]` : undefined;
    out("LAUNCHER", [describe(web, "web"), describe(worker, "worker")].filter(Boolean).join("; "));
    out("LAUNCHER", "Refusing to modify runtime metadata or terminate anything until this is resolved manually.");
    return { ...saved, ambiguous: true };
  }
  const resolvedWeb = web.status === "adopted" ? { ...saved.web, ...web.record, role: "web" } : saved.web;
  const resolvedWorker = worker.status === "adopted" ? { ...saved.worker, ...worker.record, role: "worker" } : saved.worker;
  const adopted = web.status === "adopted" || worker.status === "adopted";
  if (launcherAlive) {
    if (!adopted) return saved;
    // The wrapper exited but a verified real descendant is still running: persist the
    // upgrade so status:local/stop:local (and this launcher's own later lookups) target
    // the real process instead of the dead wrapper PID.
    const updated = { ...saved, web: resolvedWeb, worker: resolvedWorker };
    await writeRuntime(updated);
    return updated;
  }
  // The launcher process itself is gone (or its PID was reused), so it can no longer
  // run its own shutdown path. Opportunistically terminate whatever web/worker it was
  // still tracking - each still identity-verified (and, if the immediate PID had already
  // exited, resolved to its one verified live descendant above) before being touched -
  // before discarding the now-unverifiable metadata, so a crashed launcher never leaks
  // orphaned launcher-owned processes.
  await terminateRecorded(resolvedWorker);
  await terminateRecorded(resolvedWeb);
  await rm(runtimeFile, { force: true });
  return undefined;
}
export async function portInUse(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(true));
    server.once("listening", () => server.close(() => resolve(false)));
    server.listen(port, "127.0.0.1");
  });
}
async function docker(args) { return execFile("docker", ["compose", ...args], { cwd: root, windowsHide: true }); }
async function composeServiceStatuses() {
  try {
    const { stdout } = await docker(["ps", "--format", "json"]);
    return stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch { return []; }
}
// Resolves the host port a dependency should bind to, without ever guessing at
// another process's ownership. If our own compose service is already running we
// reuse whatever port it is configured for (compose itself reconciles a changed
// port by recreating the container). Otherwise we probe the preferred port: if
// free, use it; if it is the well-known OS default and occupied, fall back to the
// dedicated MVPmultiAI port (never someone else's); any other occupied port is a
// hard error so we never silently rewrite the environment onto an unrelated service.
export async function resolveServicePort({ label, urlEnvVar, portEnvVar, defaultPort, legacyPort, running }) {
  const configured = new URL(process.env[urlEnvVar]);
  const preferred = Number(configured.port || defaultPort);
  const usePort = (port) => {
    process.env[portEnvVar] = String(port);
    if (port !== preferred) { configured.port = String(port); process.env[urlEnvVar] = configured.toString(); }
    return port;
  };
  if (running || !(await portInUse(preferred))) return usePort(preferred);
  if (preferred === legacyPort && legacyPort !== defaultPort && !(await portInUse(defaultPort))) {
    out("LAUNCHER", `${label} port ${preferred} is occupied by another process (not managed by this launcher); using the dedicated MVPmultiAI port ${defaultPort} instead.`);
    return usePort(defaultPort);
  }
  throw new Error(`${label} port ${preferred} is in use by an unverified process; refusing to terminate it. Free that port or configure a different one in .env.`);
}
async function ensureDependencies() {
  const statuses = await composeServiceStatuses();
  const isRunning = (name) => statuses.some((service) => service.Service === name && /running/i.test(service.State ?? ""));
  await resolveServicePort({ label: "PostgreSQL", urlEnvVar: "DATABASE_URL", portEnvVar: "PROJECT_RELAY_POSTGRES_PORT", defaultPort: 5434, legacyPort: 5432, running: isRunning("postgres") });
  await resolveServicePort({ label: "Redis", urlEnvVar: "REDIS_URL", portEnvVar: "PROJECT_RELAY_REDIS_PORT", defaultPort: 6380, legacyPort: 6379, running: isRunning("redis") });
  out("LAUNCHER", "Starting local PostgreSQL and Redis if needed.");
  try {
    await docker(["up", "-d", "postgres", "redis"]);
  } catch (error) {
    throw new Error(`Failed to start MVPmultiAI PostgreSQL/Redis containers: ${safeText(error?.stderr || error?.message || error)}`);
  }
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const services = await composeServiceStatuses();
    const ready = ["postgres", "redis"].every((name) => services.some((service) => service.Service === name && /healthy/i.test(service.Health ?? "")));
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("PostgreSQL and Redis did not become healthy. Web and worker were not started.");
}
async function requireEnvironment() {
  for (const name of ["DATABASE_URL", "REDIS_URL"]) if (!process.env[name]) throw new Error(`${name} is required; copy .env.example to .env.`);
  if (!(await stat(path.join(root, "node_modules", ".prisma")).catch(() => undefined))) {
    throw new Error("Prisma native client is missing. Run npm run db:generate before dev:local.");
  }
}
async function rotate(log) {
  await mkdir(logDir, { recursive: true });
  const previous = `${log}.1`;
  const info = await stat(log).catch(() => undefined);
  if (info?.size > 1_000_000) { await rm(previous, { force: true }); await writeFile(previous, await readFile(log)); await rm(log); }
}
// Real (non-override) launches spawn the actual next/tsx entrypoint with node directly -
// exactly what next.cmd/tsx.cmd would themselves exec - instead of going through `npm
// run <script>`. On Windows, `npm run` chains cmd.exe -> npm-cli.js -> another cmd.exe ->
// the real node process; if any link in that chain exits before the real process does,
// the launcher is left holding a dead PID while the real long-lived web/worker process
// keeps running, untracked (removeStaleRuntime's descendant-adoption logic exists as a
// safety net for exactly that shape of failure, but avoiding the wrapper chain here
// removes the defect at its source for the production path). Spawning the entrypoint
// directly makes child.pid *be* the real long-lived process.
const directEntry = {
  WEB: { module: ["node_modules", "next", "dist", "bin", "next"], args: ["dev", "--hostname", "127.0.0.1"], cwd: ["apps", "web"] },
  WORKER: { module: ["node_modules", "tsx", "dist", "cli.mjs"], args: ["watch", "src/index.ts"], cwd: ["apps", "worker"] },
};
async function assertWebLoopback() {
  // Mirrors apps/web's own "predev" hook (scripts/assert-loopback.mjs). Launching next
  // directly bypasses npm's per-workspace pre-script lifecycle, so that safety check
  // (refuse to bind non-loopback hosts) has to be run here instead.
  const webRoot = path.join(root, "apps", "web");
  await execFile(process.execPath, [path.join(webRoot, "scripts", "assert-loopback.mjs")], { cwd: webRoot, env: process.env, windowsHide: true });
}
function startChild(name, overrideEnvVar) {
  const log = path.join(logDir, `${name.toLowerCase()}.log`);
  // overrideEnvVar lets tests substitute a harmless fixture process for the real
  // next/tsx entrypoint. Unset in normal use, where behavior is unchanged.
  const override = overrideEnvVar && process.env[overrideEnvVar];
  const options = { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false };
  let child;
  if (override) {
    const [cmd, args] = JSON.parse(override);
    // Overrides spawn an absolute executable directly and never need shell/PATH
    // resolution; a shell would mis-tokenize a path containing spaces (e.g. "C:\Program
    // Files\nodejs\node.exe") since it is not auto-quoted as the command itself.
    child = spawn(cmd, args, options);
  } else {
    const entry = directEntry[name];
    child = spawn(process.execPath, [path.join(root, ...entry.module), ...entry.args], { ...options, cwd: path.join(root, ...entry.cwd) });
  }
  const relay = (stream) => stream.on("data", (chunk) => {
    const text = safeText(chunk.toString());
    process.stdout.write(`[${name}] ${text}`);
    void appendFile(log, `[${new Date().toISOString()}] ${text}`);
  });
  relay(child.stdout); relay(child.stderr);
  return { child, log };
}
export async function terminateRecorded(record) {
  if (!record?.pid || !record.startIdentity) return "not-recorded";
  const current = await processIdentity(record.pid);
  if (!current) return "already-exited";
  if (current !== record.startIdentity) return "identity-mismatch";
  // Bounded graceful attempt first.
  if (isWindows) await execFile("taskkill", ["/pid", String(record.pid), "/t"], { windowsHide: true }).catch(() => undefined);
  else process.kill(record.pid, "SIGTERM");
  for (let attempt = 0; attempt < 30; attempt += 1) { if (!(await processIdentity(record.pid))) return "terminated"; await new Promise((r) => setTimeout(r, 100)); }
  // Still alive after the graceful window: re-verify identity before escalating, so a
  // reused PID is never force-killed.
  const survivor = await processIdentity(record.pid);
  if (survivor !== record.startIdentity) return survivor ? "identity-mismatch" : "already-exited";
  if (isWindows) await execFile("taskkill", ["/pid", String(record.pid), "/t", "/f"], { windowsHide: true }).catch(() => undefined);
  else process.kill(record.pid, "SIGKILL");
  for (let attempt = 0; attempt < 20; attempt += 1) { if (!(await processIdentity(record.pid))) return "terminated"; await new Promise((r) => setTimeout(r, 100)); }
  return "termination-unconfirmed";
}
async function checkCli(label, cmd) {
  try {
    // cmd resolves to a .cmd shim on Windows, which needs a shell to run; exec (a
    // single fixed command string, no untrusted input) avoids the args-with-shell
    // escaping pitfall execFile/spawn would hit when combining an args array with
    // shell:true.
    const { stdout } = await exec(`${cmd} --version`, { windowsHide: true, timeout: 5000 });
    return `${label}=${stdout.trim().split(/\r?\n/)[0] || "ok"}`;
  } catch {
    return `${label}=unavailable`;
  }
}
async function providerHealth() {
  const [codex, claude] = await Promise.all([checkCli("codex", "codex"), checkCli("claude", "claude")]);
  return `${codex}; ${claude}`;
}
async function healthy() {
  try { const response = await fetch(url, { signal: AbortSignal.timeout(1500) }); return response.ok; } catch { return false; }
}
async function waitForWeb(web, workerFailed) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await healthy()) return;
    if (web.exitCode !== null) throw new Error("Web process exited before becoming healthy.");
    if (workerFailed?.()) throw new Error("Worker exited before web became healthy. Check .project-relay/logs/worker.log.");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Web did not respond on 127.0.0.1:${webPort}.`);
}
function browserCommand(target) {
  // Overridable only for tests, so a test run never actually launches a browser.
  const override = process.env.PROJECT_RELAY_BROWSER_COMMAND_OVERRIDE;
  if (override) { const [cmd, args] = JSON.parse(override); return [cmd, [...args, target]]; }
  if (isWindows) return ["cmd", ["/c", "start", "", target]];
  if (process.platform === "darwin") return ["open", [target]];
  return ["xdg-open", [target]];
}
export async function statusLocal() {
  const saved = await removeStaleRuntime();
  if (saved?.ambiguous) {
    out("LAUNCHER", "Web: ambiguous; worker: ambiguous; resolve ownership manually (see log above) before continuing.");
    return { saved, web: false, worker: false };
  }
  const web = saved ? await processIdentity(saved.web?.pid) === saved.web?.startIdentity : false;
  const worker = saved ? await processIdentity(saved.worker?.pid) === saved.worker?.startIdentity : false;
  let services = "unavailable";
  try { services = (await docker(["ps", "--format", "{{.Service}} {{.Health}}"])).stdout.trim() || "not running"; } catch { /* reported below */ }
  const providers = await providerHealth();
  out("LAUNCHER", `Web: ${web ? "running" : "stopped"}; worker: ${worker ? "running" : "stopped"}; URL: ${url}`);
  out("LAUNCHER", `Docker services: ${services}`);
  out("LAUNCHER", `Providers: ${providers}`);
  return { saved, web, worker };
}
export async function stopLocal() {
  const saved = await removeStaleRuntime();
  if (!saved) { out("LAUNCHER", "No verified local launcher metadata found."); return; }
  if (saved.ambiguous) { out("LAUNCHER", "Refusing to stop: ownership is ambiguous for a prior launcher-owned process (see log above). Resolve manually, then retry."); return; }
  out("LAUNCHER", `Worker: ${await terminateRecorded(saved.worker)}; web: ${await terminateRecorded(saved.web)}.`);
  await rm(runtimeFile, { force: true });
  out("LAUNCHER", `Port ${webPort} ${await portInUse(webPort) ? "is still in use by an unverified process" : "released"}.`);
}
export async function startLocal() {
  assertRepository();
  const existing = await removeStaleRuntime();
  if (existing) {
    if (existing.ambiguous) throw new Error("A prior launcher-owned process has ambiguous ownership; resolve manually (see status:local output) before starting again.");
    await statusLocal();
    return;
  }
  if (await portInUse(webPort)) throw new Error(`Port ${webPort} is owned by an unverified process; refusing to terminate it.`);
  await loadLocalEnvironment();
  await requireEnvironment();
  // Skippable only for tests exercising process orchestration with fixture web/worker
  // processes, which do not need real PostgreSQL/Redis. Unset in normal use.
  if (process.env.PROJECT_RELAY_SKIP_DEPENDENCIES !== "true") {
    await ensureDependencies();
    out("LAUNCHER", "Applying checked-in database migrations.");
    // npm resolves to npm.cmd on Windows, which needs a shell to run; exec (a single
    // fixed command string, no untrusted input) avoids the args-with-shell escaping
    // pitfall that execFile/spawn would hit when combining an args array with shell:true.
    await exec("npm run db:migrate", { cwd: root, windowsHide: true });
  }
  await Promise.all([rotate(path.join(logDir, "web.log")), rotate(path.join(logDir, "worker.log"))]);
  if (!process.env.PROJECT_RELAY_WEB_COMMAND_OVERRIDE) await assertWebLoopback();
  const web = startChild("WEB", "PROJECT_RELAY_WEB_COMMAND_OVERRIDE");
  const worker = startChild("WORKER", "PROJECT_RELAY_WORKER_COMMAND_OVERRIDE");
  const metadata = {
    launcherPid: process.pid, launcherStartIdentity: await processIdentity(process.pid),
    web: { pid: web.child.pid, startIdentity: await processIdentity(web.child.pid), role: "web", parentPid: process.pid },
    worker: { pid: worker.child.pid, startIdentity: await processIdentity(worker.child.pid), role: "worker", parentPid: process.pid },
    startedAt: new Date().toISOString(), ports: [webPort], repositoryRoot: root,
  };
  if (!metadata.web.startIdentity || !metadata.worker.startIdentity) { await terminateRecorded(metadata.worker); await terminateRecorded(metadata.web); throw new Error("Could not record child process ownership."); }
  await writeRuntime(metadata);
  let keepAlive;
  const shutdown = async () => { clearInterval(keepAlive); out("LAUNCHER", "Stopping only launcher-owned process trees."); await stopLocal(); process.exit(0); };
  process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
  let workerExitCode = null;
  let startupComplete = false;
  worker.child.on("exit", (code) => {
    workerExitCode = code;
    if (startupComplete && code !== 0) {
      out("LAUNCHER", "Worker exited unexpectedly; stopping the owned web process.");
      void stopLocal().finally(() => { process.exitCode = 1; });
    }
  });
  try { await waitForWeb(web.child, () => workerExitCode !== null); } catch (error) { await stopLocal(); throw error; }
  if (workerExitCode !== null && workerExitCode !== 0) {
    await stopLocal();
    throw new Error(`Worker exited before startup completed (code ${workerExitCode}). Check .project-relay/logs/worker.log.`);
  }
  startupComplete = true;
  out("LAUNCHER", `Ready: ${url}`);
  if (process.env.PROJECT_RELAY_OPEN_BROWSER !== "false") {
    const [cmd, args] = browserCommand(url);
    spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
  }
  // Keep this process resident until an explicit shutdown signal, independent of the
  // web/worker child handles: relying only on those (e.g. their stdout/stderr pipes) to
  // keep the event loop alive means the launcher itself could silently exit the moment an
  // intermediate wrapper's own pipes close - well before the real process it spawned
  // does - leaving the session unsupervised without ever running the shutdown path.
  keepAlive = setInterval(() => {}, 60_000);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const command = process.argv[2] ?? "start";
  const action = command === "stop" ? stopLocal : command === "status" ? statusLocal : startLocal;
  action().catch((error) => { out("LAUNCHER", safeText(error instanceof Error ? error.message : error)); process.exitCode = 1; });
}
