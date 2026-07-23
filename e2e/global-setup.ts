import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crossSpawn from "cross-spawn";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
loadDotEnv(path.resolve(__dirname, "..", ".env"));

const WORKSPACE_MANIFEST = path.join(__dirname, ".e2e-workspace.json");

function run(command: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = crossSpawn(command, args, { stdio: "inherit", cwd, shell: false });
    child.once("error", reject);
    child.once("close", code => (code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} exited with code ${String(code)}`))));
  });
}

export default async function globalSetup(): Promise<void> {
  const repoRoot = path.resolve(__dirname, "..");

  // Disposable Postgres + Redis, targeting the dedicated "projectrelay-validation" compose
  // project explicitly (idempotent: a no-op if already running). Never omit -p here: the
  // default project name is derived from the current directory and can collide with an
  // unrelated, already-running stack that happens to share a container name prefix.
  await run("docker", ["compose", "-p", "projectrelay-validation", "-f", "docker-compose.yml", "-f", "docker-compose.validation.yml", "up", "-d", "--wait"], repoRoot);
  await run("npx", ["prisma", "migrate", "deploy", "--schema", "packages/database/prisma/schema.prisma"], repoRoot);

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
