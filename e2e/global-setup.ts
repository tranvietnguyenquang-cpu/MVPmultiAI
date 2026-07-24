import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crossSpawn from "cross-spawn";
import { assertDisposableDatabaseUrl, assertDisposableRedisUrl } from "@project-relay/shared";
import { ensureDisposablePostgresDatabase, migrateDisposableDatabase } from "../scripts/test-infra/ensure-disposable-database.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Minimal .env loader (no dotenv dependency): loads the disposable test database/Redis
 * connection details from .env.test - deliberately never the repo-root .env, which holds
 * the same DATABASE_URL/REDIS_URL `npm run dev:local` uses for the real local-beta stack.
 */
function loadDotEnv(file: string): void {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key]) continue;
    process.env[key] = rawValue.replace(/^["']|["']$/g, "");
  }
}
loadDotEnv(path.resolve(__dirname, "..", ".env.test"));
process.env.PROJECT_RELAY_TEST_MODE = "true";

const WORKSPACE_MANIFEST = path.join(__dirname, ".e2e-workspace.json");

function run(command: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = crossSpawn(command, args, { stdio: "inherit", cwd, shell: false });
    child.once("error", reject);
    child.once("close", code => (code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} exited with code ${String(code)}`))));
  });
}

export default async function globalSetup(): Promise<void> {
  // Fails fast, before any container is touched or any row is written, if .env.test ever
  // resolved to anything but an explicitly disposable database/Redis instance.
  assertDisposableDatabaseUrl(process.env.DATABASE_URL);
  assertDisposableRedisUrl(process.env.REDIS_URL);

  // Disposable Postgres + Redis, targeting the dedicated "projectrelay-validation" compose
  // project explicitly (idempotent: a no-op if already running). Never omit -p here: the
  // default project name is derived from the current directory and can collide with an
  // unrelated, already-running stack that happens to share a container name prefix.
  const databaseName = decodeURIComponent(new URL(process.env.DATABASE_URL!).pathname.replace(/^\//, ""));
  await ensureDisposablePostgresDatabase(databaseName);
  await migrateDisposableDatabase(process.env.DATABASE_URL!);

  // A disposable Git workspace so seeded Projects have a real, valid repositoryPath.
  const workspace = mkdtempSync(path.join(tmpdir(), "project-relay-e2e-"));
  await run("git", ["init"], workspace);
  await run("git", ["config", "user.email", "e2e@project-relay.local"], workspace);
  await run("git", ["config", "user.name", "ProjectRelay E2E"], workspace);
  writeFileSync(path.join(workspace, "README.md"), "Disposable git workspace for Playwright browser verification.\n");
  await run("git", ["add", "-A"], workspace);
  await run("git", ["commit", "-m", "init"], workspace);
  writeFileSync(WORKSPACE_MANIFEST, JSON.stringify({ workspace, runId: `playwright-${randomUUID()}` }));

  // Both providers healthy so the composer's "auto"/explicit routing can queue messages
  // without depending on whatever CLIs happen to be installed on the host.
  const { prisma } = await import("@project-relay/database");
  const healthy = { installed: true, authentication: "AUTHENTICATED" as const, available: true };
  await prisma.providerHealth.upsert({ where: { providerId: "codex-cli" }, create: { providerId: "codex-cli", ...healthy }, update: healthy });
  await prisma.providerHealth.upsert({ where: { providerId: "claude-cli" }, create: { providerId: "claude-cli", ...healthy }, update: healthy });
  await prisma.$disconnect();
}
