// Provisions the Postgres database automated tests/verification connect to, inside the
// dedicated "projectrelay-validation" Docker Compose project (docker-compose.yml +
// docker-compose.validation.yml, ports 55432/56379) - never the "mvpmultiai" project's
// local-beta stack (5434/6380) that `npm run dev:local` uses. That container only auto-
// creates its default POSTGRES_DB ("projectrelay") on first init, so a same-server
// sibling database with a disposable-allowlisted name is created here idempotently.
import crossSpawn from "cross-spawn";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const COMPOSE_PROJECT = "projectrelay-validation";
const DISPOSABLE_DATABASE_NAME_PATTERN = /^projectrelay_(?:test|validation|e2e)_[a-z0-9_]+$/;

function run(command, args) {
  return new Promise((resolve, reject) => {
    // cross-spawn (not node:child_process directly) so a Windows .cmd shim (npx, docker
    // Desktop's wrapper, etc.) resolves and escapes correctly without needing shell:true.
    const child = crossSpawn(command, args, { cwd: repoRoot, windowsHide: true, shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} ${args.join(" ")} failed (exit ${code}): ${(stderr || stdout).trim()}`));
    });
  });
}

/** Starts the disposable Postgres/Redis containers (idempotent) and creates `databaseName` inside the disposable Postgres server if it does not already exist. Refuses any name outside the disposable allowlist. */
export async function ensureDisposablePostgresDatabase(databaseName) {
  if (!DISPOSABLE_DATABASE_NAME_PATTERN.test(databaseName)) {
    throw new Error(`Refusing to provision non-disposable database name '${databaseName}'.`);
  }
  await run("docker", ["compose", "-p", COMPOSE_PROJECT, "-f", "docker-compose.yml", "-f", "docker-compose.validation.yml", "up", "-d", "--wait", "postgres", "redis"]);
  const exists = await run("docker", ["compose", "-p", COMPOSE_PROJECT, "exec", "-T", "postgres", "psql", "-U", "projectrelay", "-d", "projectrelay", "-tAc", `SELECT 1 FROM pg_database WHERE datname='${databaseName}'`]);
  if (!exists.trim()) {
    await run("docker", ["compose", "-p", COMPOSE_PROJECT, "exec", "-T", "postgres", "psql", "-U", "projectrelay", "-d", "projectrelay", "-c", `CREATE DATABASE "${databaseName}"`]);
  }
}

export async function migrateDisposableDatabase(databaseUrl) {
  await new Promise((resolve, reject) => {
    const child = crossSpawn("npx", ["prisma", "migrate", "deploy", "--schema", "packages/database/prisma/schema.prisma"], {
      cwd: repoRoot,
      windowsHide: true,
      shell: false,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: "inherit"
    });
    child.once("error", reject);
    child.once("close", (code) => (code === 0 ? resolve() : reject(new Error(`prisma migrate deploy failed (exit ${code})`))));
  });
}
