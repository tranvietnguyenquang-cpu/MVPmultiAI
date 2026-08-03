import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createRelayV2Client } from "./client.js";
import { toPrismaSqliteUrl } from "./paths.js";

const execFileAsync = promisify(execFile);

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const realSchemaPath = path.join(repositoryRoot, "packages", "relay-v2-persistence", "prisma", "schema.prisma");
const realMigrationsDir = path.join(repositoryRoot, "packages", "relay-v2-persistence", "prisma", "migrations");
const prismaCli = path.join(repositoryRoot, "node_modules", "prisma", "build", "index.js");

const ALL_MIGRATIONS = [
  "20260801000000_milestone1_init",
  "20260802000000_milestone2_execution_engine",
  "20260803000000_milestone22_codex_cli",
  "20260804000000_milestone23a_review_engine"
];

/**
 * Prisma requires a schema's `migrations` folder to sit next to schema.prisma
 * itself, so this stages a disposable copy of the real schema alongside
 * whichever subset of the real (checked-in) migrations we want applied —
 * never a rewritten or synthetic migration.
 */
async function stageSchemaWithMigrations(migrationNames: readonly string[]): Promise<{ schemaPath: string; cleanup: () => Promise<void> }> {
  const stageDir = await mkdtemp(path.join(tmpdir(), "relay-v2-migration-path-"));
  const prismaDir = path.join(stageDir, "prisma");
  const migrationsDir = path.join(prismaDir, "migrations");
  await mkdir(migrationsDir, { recursive: true });
  await cp(path.join(realMigrationsDir, "migration_lock.toml"), path.join(migrationsDir, "migration_lock.toml"));
  for (const name of migrationNames) {
    await cp(path.join(realMigrationsDir, name), path.join(migrationsDir, name), { recursive: true });
  }
  // migrate deploy only reads the datasource block and applies the sibling
  // migrations folder verbatim — it never diffs the schema against them — so
  // the real (unmodified) schema.prisma text is reused as-is.
  const schemaPath = path.join(prismaDir, "schema.prisma");
  await cp(realSchemaPath, schemaPath);
  return { schemaPath, cleanup: () => rm(stageDir, { recursive: true, force: true }) };
}

describe("Milestone 2.3A migration path", () => {
  let dataDir: string | undefined;
  let stageCleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await stageCleanup?.();
    stageCleanup = undefined;
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  });

  it("applies cleanly on a fresh database (all four migrations in one deploy)", async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "relay-v2-migration-fresh-"));
    const databasePath = path.join(dataDir, "relay-v2.db");
    const env = { ...process.env, RELAY_V2_DATABASE_URL: toPrismaSqliteUrl(databasePath) };
    await execFileAsync(process.execPath, [prismaCli, "migrate", "deploy", "--schema", realSchemaPath], { cwd: repositoryRoot, env, windowsHide: true });

    const client = (await createRelayV2Client({ dataDir, testMode: true })).client;
    const applied = await client.$queryRawUnsafe<Array<{ migration_name: string }>>('SELECT migration_name FROM "_prisma_migrations" ORDER BY migration_name');
    expect(applied.map(row => row.migration_name)).toEqual(ALL_MIGRATIONS);
    const columns = await client.$queryRawUnsafe<Array<{ name: string }>>('PRAGMA table_info("ReviewRequest")');
    expect(columns.map(column => column.name)).toEqual(expect.arrayContaining(["reviewInputJson", "reviewInputHash", "reviewerConfigJson", "reviewerConfigHash", "requestHash"]));
    const triggers = await client.$queryRawUnsafe<Array<{ name: string }>>("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'ReviewRequest'");
    expect(triggers.map(trigger => trigger.name)).toEqual(expect.arrayContaining(["ReviewRequest_terminal_immutable", "ReviewRequest_immutable_payload", "ReviewRequest_no_delete"]));
    await client.$disconnect();
  }, 30_000);

  it("applies incrementally on top of an existing Alpha 0.3 database (migrations 1-3 already applied, then migration 4 deployed separately)", async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "relay-v2-migration-incremental-"));
    const databasePath = path.join(dataDir, "relay-v2.db");
    const env = { ...process.env, RELAY_V2_DATABASE_URL: toPrismaSqliteUrl(databasePath) };

    const alpha03 = await stageSchemaWithMigrations(ALL_MIGRATIONS.slice(0, 3));
    await execFileAsync(process.execPath, [prismaCli, "migrate", "deploy", "--schema", alpha03.schemaPath], { cwd: repositoryRoot, env, windowsHide: true });

    {
      const client = (await createRelayV2Client({ dataDir, testMode: true })).client;
      const applied = await client.$queryRawUnsafe<Array<{ migration_name: string }>>('SELECT migration_name FROM "_prisma_migrations" ORDER BY migration_name');
      expect(applied.map(row => row.migration_name)).toEqual(ALL_MIGRATIONS.slice(0, 3));
      await expect(client.$queryRawUnsafe('SELECT 1 FROM "ReviewRequest" LIMIT 1')).rejects.toThrow();
      await client.$disconnect();
    }
    await alpha03.cleanup();

    // Same on-disk database, now deployed against the full (real, checked-in)
    // migrations folder — this is the actual upgrade path an existing Alpha
    // 0.3 installation takes, not a fresh database.
    await execFileAsync(process.execPath, [prismaCli, "migrate", "deploy", "--schema", realSchemaPath], { cwd: repositoryRoot, env, windowsHide: true });

    const client = (await createRelayV2Client({ dataDir, testMode: true })).client;
    const applied = await client.$queryRawUnsafe<Array<{ migration_name: string }>>('SELECT migration_name FROM "_prisma_migrations" ORDER BY migration_name');
    expect(applied.map(row => row.migration_name)).toEqual(ALL_MIGRATIONS);
    const columns = await client.$queryRawUnsafe<Array<{ name: string }>>('PRAGMA table_info("ReviewRequest")');
    expect(columns.map(column => column.name)).toContain("reviewerConfigHash");
    await client.$disconnect();
  }, 30_000);
});
