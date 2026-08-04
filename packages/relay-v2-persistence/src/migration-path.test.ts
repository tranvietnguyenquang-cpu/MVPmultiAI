import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createRelayV2Client, type RelayV2Database } from "./client.js";
import { toPrismaSqliteUrl } from "./paths.js";

/**
 * Reads a ReviewRequest's post-rollback state with raw SQL, naming only
 * columns the 2.3A schema has. After a failed 2.3B migration the database is
 * still 2.3A, but the Prisma client is generated from the CURRENT schema and
 * would select the columns 2.3B adds -- so the typed client cannot be used to
 * assert that the rollback left a genuine 2.3A database behind.
 */
async function read23aReviewRequest(client: RelayV2Database, id: string): Promise<{ status: string; verdicts: number; events: number }> {
  const rows = await client.$queryRawUnsafe<Array<{ status: string }>>('SELECT "status" FROM "ReviewRequest" WHERE "id" = ?', id);
  if (!rows.length) throw new Error(`ReviewRequest ${id} did not survive the rollback.`);
  const verdicts = await client.$queryRawUnsafe<Array<{ n: bigint | number }>>('SELECT COUNT(*) AS n FROM "ReviewVerdict" WHERE "reviewRequestId" = ?', id);
  const events = await client.$queryRawUnsafe<Array<{ n: bigint | number }>>('SELECT COUNT(*) AS n FROM "ReviewEvent" WHERE "reviewRequestId" = ?', id);
  return { status: rows[0]!.status, verdicts: Number(verdicts[0]?.n ?? 0), events: Number(events[0]?.n ?? 0) };
}


const execFileAsync = promisify(execFile);

const HASH64 = "a".repeat(64);

/**
 * Seeds a fully realistic Milestone 2.3A review graph directly through the
 * Prisma client (never raw SQL, so every column default/`@updatedAt` is
 * handled identically to production code) against a database that has only
 * migrations 1 through 2.3A applied: a project, a task with its approval, two
 * execution sessions (kept separate because ReviewRequest's partial unique
 * index allows only one active review per session), an ACTIVE (PENDING)
 * FakeReviewer request, and a TERMINAL (APPROVED) FakeReviewer request with
 * its ReviewVerdict and ReviewEvent rows and an AuditEvent. This never calls
 * ReviewEngine (which now also writes ReviewInvocation, a table that does not
 * exist yet at this migration level) -- it reproduces exactly the row shapes
 * ReviewEngine itself would have produced prior to Milestone 2.3B.
 */
async function seedMilestone23aReviewGraph(client: import("../generated/client/index.js").PrismaClient) {
  const project = await client.project.create({ data: {
    id: randomUUID(), name: "Migration Seed Project", slug: `migration-seed-${randomUUID()}`,
    localPath: "C:\\migration-seed", pathKey: `c:\\migration-seed-${randomUUID()}`
  } });
  const task = await client.task.create({ data: {
    id: randomUUID(), projectId: project.id, idempotencyKey: "seed-1", title: "Seed task", objective: "Prove migration preservation",
    source: "MANUAL", taskType: "IMPLEMENTATION", complexity: "NORMAL", status: "AWAITING_USER_ACCEPTANCE",
    specHash: HASH64, normalizedSpecJson: JSON.stringify({ dummy: true }), reviewer: "CLAUDE"
  } });
  const approval = await client.approval.create({ data: {
    id: randomUUID(), taskId: task.id, approvalType: "TASK", requestedBy: "tester", resolvedBy: "tester", status: "APPROVED",
    specHash: HASH64, approvedSpecJson: JSON.stringify({ task: { dummy: true } }), executor: "FAKE", model: "AUTO", effort: "AUTO",
    reviewer: "CLAUDE", permissionsJson: "[]"
  } });

  async function createSession(idempotencySuffix: string) {
    return client.executionSession.create({ data: {
      id: randomUUID(), taskId: task.id, projectId: project.id, executorId: "fake", status: "SUCCEEDED",
      workspacePath: `C:\\migration-seed\\${idempotencySuffix}`, workspaceKey: `migration-seed-${idempotencySuffix}`,
      approvedSpecHash: HASH64, approvedExecutor: "FAKE", approvedModel: "AUTO", approvedEffort: "AUTO", approvedReviewer: "CLAUDE",
      approvedPermissionsHash: HASH64, summary: "Fake execution completed."
    } });
  }
  const activeSession = await createSession("active");
  const terminalSession = await createSession("terminal");

  function reviewRequestData(session: { id: string }, overrides: Record<string, unknown>) {
    return {
      id: randomUUID(), executionSessionId: session.id, projectId: project.id, taskId: task.id,
      reviewerId: "fake-reviewer", reviewAuthority: "DIAGNOSTIC", diagnosticRequested: true,
      approvalId: approval.id, approvalStatus: "APPROVED", approvalReviewerSelection: "CLAUDE", taskSelectedReviewer: "CLAUDE",
      executionExecutorId: "fake", taskSpecHash: HASH64, approvalSnapshotHash: HASH64, executionCapsuleHash: HASH64,
      baselineGitEvidenceHash: HASH64, finalGitEvidenceHash: HASH64, verificationResultsHash: HASH64, executionArtifactSetHash: HASH64,
      executionResultStatus: "succeeded", finalBranch: "main", finalHead: "deadbeef", reviewPolicyVersion: "2.3A-v1",
      reviewInputJson: JSON.stringify({ dummy: true }), reviewInputHash: HASH64, requestHash: HASH64,
      reviewerConfigJson: JSON.stringify({ outcome: "approve" }), reviewerConfigHash: HASH64, requestedBy: "tester",
      ...overrides
    };
  }

  /**
   * Inserts a ReviewRequest naming ONLY the columns that exist in the 2.3A
   * schema. The Prisma client is generated from the CURRENT schema, so
   * `client.reviewRequest.create` would also send the columns 2.3B adds --
   * which is precisely what this test must not do, since its whole point is
   * to seed a genuine pre-2.3B database and then migrate it.
   */
  async function seedReviewRequest23a(data: Record<string, unknown>): Promise<{ id: string }> {
    const columns = Object.keys(data);
    const placeholders = columns.map(() => "?").join(", ");
    const values = columns.map(column => {
      const value = data[column];
      return value instanceof Date ? value.getTime() : typeof value === "boolean" ? (value ? 1 : 0) : value;
    });
    await client.$executeRawUnsafe(
      `INSERT INTO "ReviewRequest" (${columns.map(column => `"${column}"`).join(", ")}, "updatedAt") VALUES (${placeholders}, ?)`,
      ...values, Date.now()
    );
    return { id: data.id as string };
  }

  const active = await seedReviewRequest23a(reviewRequestData(activeSession, { status: "PENDING" }));
  const terminal = await seedReviewRequest23a(reviewRequestData(terminalSession, {
    status: "APPROVED", ownerId: "seed-owner", leaseToken: randomUUID(), claimedAt: new Date(), heartbeatAt: new Date(),
    startedAt: new Date(), finishedAt: new Date(), claimAttempts: 1
  }));
  await client.reviewVerdict.create({ data: {
    id: randomUUID(), reviewRequestId: terminal.id, verdict: "APPROVE", summary: "Looks good.",
    findingsJson: "[]", requiredActionsJson: "[]", confidence: 1, reviewerVersion: "fake-reviewer@1", reviewedRequestHash: HASH64
  } });
  await client.reviewEvent.create({ data: {
    id: randomUUID(), reviewRequestId: terminal.id, sequence: 1, eventType: "REVIEW_REQUESTED", level: "INFO",
    message: "Review requested from FakeReviewer.", payloadJson: "{}"
  } });
  await client.reviewEvent.create({ data: {
    id: randomUUID(), reviewRequestId: terminal.id, sequence: 2, eventType: "REVIEW_APPROVED", level: "INFO",
    message: "Looks good.", payloadJson: "{}"
  } });
  await client.auditEvent.create({ data: {
    id: randomUUID(), projectId: project.id, taskId: task.id, executionSessionId: terminalSession.id, actor: "review-engine",
    action: "REVIEW_VERDICT_RECORDED", riskLevel: "REVIEW", detailsJson: JSON.stringify({ reviewRequestId: terminal.id, verdict: "APPROVE" })
  } });

  return { project, task, approval, activeSession, terminalSession, active, terminal };
}

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const realSchemaPath = path.join(repositoryRoot, "packages", "relay-v2-persistence", "prisma", "schema.prisma");
const realMigrationsDir = path.join(repositoryRoot, "packages", "relay-v2-persistence", "prisma", "migrations");
const prismaCli = path.join(repositoryRoot, "node_modules", "prisma", "build", "index.js");

const ALL_MIGRATIONS = [
  "20260801000000_milestone1_init",
  "20260802000000_milestone2_execution_engine",
  "20260803000000_milestone22_codex_cli",
  "20260804000000_milestone23a_review_engine",
  "20260805000000_milestone23b_claude_reviewer"
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

describe("Milestone 2.3B migration path (Alpha 0.3 -> 2.3A -> 2.3B)", () => {
  let dataDir: string | undefined;
  let stageCleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await stageCleanup?.();
    stageCleanup = undefined;
    // maxRetries/retryDelay: on Windows, SQLite's WAL side files can briefly
    // remain locked immediately after $disconnect() resolves; matches the
    // same Windows-safe cleanup pattern used elsewhere in this codebase
    // (e.g. disposable-codex-smoke.ts's workspace cleanup).
    if (dataDir) await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    dataDir = undefined;
  });

  it("applies cleanly on a fresh database (all five migrations in one deploy)", async () => {
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
    // The Milestone 2.3A CHECK pinned reviewerId to exactly 'fake-reviewer'; the
    // 2.3B migration must have widened it to also allow 'claude-cli' via a
    // table rebuild, not weakened it to accept an arbitrary reviewer id.
    const reviewRequestSql = await client.$queryRawUnsafe<Array<{ sql: string }>>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'ReviewRequest'");
    expect(reviewRequestSql[0]?.sql).toMatch(/"reviewerId" IN \('fake-reviewer','claude-cli'\)/);
    const newTables = await client.$queryRawUnsafe<Array<{ name: string }>>("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('ReviewerCapabilitySnapshot', 'ReviewInvocation')");
    expect(newTables.map(table => table.name).sort()).toEqual(["ReviewInvocation", "ReviewerCapabilitySnapshot"]);
    const invocationTriggers = await client.$queryRawUnsafe<Array<{ name: string }>>("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'ReviewInvocation'");
    expect(invocationTriggers.map(trigger => trigger.name).sort()).toEqual([
      "ReviewInvocation_immutable_identity",
      // Write-once transmitted-material identity: bound at INSERT, before the
      // reviewer process exists, and never rewritable afterwards.
      "ReviewInvocation_immutable_material_identity",
      "ReviewInvocation_no_delete",
      "ReviewInvocation_terminal_immutable"
    ]);
    const invocationIndexes = await client.$queryRawUnsafe<Array<{ name: string; sql: string | null }>>("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'ReviewInvocation'");
    expect(invocationIndexes.some(index => index.sql?.includes("UNIQUE") && index.sql?.includes('"reviewRequestId"'))).toBe(true);
    await client.$disconnect();
  }, 30_000);

  it("applies incrementally on top of an existing Alpha 0.3 database (milestones 1-3 already applied, then 2.3A and 2.3B deployed separately)", async () => {
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
    // 0.3 installation takes, not a fresh database, and now carries it all
    // the way through the 2.3B reviewerId-CHECK-relaxing table rebuild.
    await execFileAsync(process.execPath, [prismaCli, "migrate", "deploy", "--schema", realSchemaPath], { cwd: repositoryRoot, env, windowsHide: true });

    const client = (await createRelayV2Client({ dataDir, testMode: true })).client;
    const applied = await client.$queryRawUnsafe<Array<{ migration_name: string }>>('SELECT migration_name FROM "_prisma_migrations" ORDER BY migration_name');
    expect(applied.map(row => row.migration_name)).toEqual(ALL_MIGRATIONS);
    const columns = await client.$queryRawUnsafe<Array<{ name: string }>>('PRAGMA table_info("ReviewRequest")');
    expect(columns.map(column => column.name)).toContain("reviewerConfigHash");
    const reviewRequestSql = await client.$queryRawUnsafe<Array<{ sql: string }>>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'ReviewRequest'");
    expect(reviewRequestSql[0]?.sql).toMatch(/"reviewerId" IN \('fake-reviewer','claude-cli'\)/);
    await client.$disconnect();
  }, 30_000);

  it("preserves an existing 2.3A FakeReviewer review graph byte-for-byte through the 2.3B migration, and every constraint/trigger still works afterward", async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "relay-v2-migration-preserve-"));
    const databasePath = path.join(dataDir, "relay-v2.db");
    const env = { ...process.env, RELAY_V2_DATABASE_URL: toPrismaSqliteUrl(databasePath) };

    const alpha23a = await stageSchemaWithMigrations(ALL_MIGRATIONS.slice(0, 4));
    await execFileAsync(process.execPath, [prismaCli, "migrate", "deploy", "--schema", alpha23a.schemaPath], { cwd: repositoryRoot, env, windowsHide: true });

    let seeded: Awaited<ReturnType<typeof seedMilestone23aReviewGraph>>;
    {
      const client = (await createRelayV2Client({ dataDir, testMode: true })).client;
      seeded = await seedMilestone23aReviewGraph(client);
      await client.$disconnect();
    }
    await alpha23a.cleanup();

    await execFileAsync(process.execPath, [prismaCli, "migrate", "deploy", "--schema", realSchemaPath], { cwd: repositoryRoot, env, windowsHide: true });

    const client = (await createRelayV2Client({ dataDir, testMode: true })).client;
    try {
      const applied = await client.$queryRawUnsafe<Array<{ migration_name: string }>>('SELECT migration_name FROM "_prisma_migrations" ORDER BY migration_name');
      expect(applied.map(row => row.migration_name)).toEqual(ALL_MIGRATIONS);

      const project = await client.project.findUniqueOrThrow({ where: { id: seeded.project.id } });
      expect(project.name).toBe(seeded.project.name);

      const active = await client.reviewRequest.findUniqueOrThrow({ where: { id: seeded.active.id } });
      expect(active.reviewerId).toBe("fake-reviewer");
      expect(active.reviewAuthority).toBe("DIAGNOSTIC");
      expect(active.status).toBe("PENDING");
      expect(active.reviewInputHash).toBe(HASH64);
      expect(active.reviewerConfigHash).toBe(HASH64);

      const terminal = await client.reviewRequest.findUniqueOrThrow({ where: { id: seeded.terminal.id }, include: { verdicts: true, events: { orderBy: { sequence: "asc" } } } });
      expect(terminal.status).toBe("APPROVED");
      expect(terminal.ownerId).toBe("seed-owner");
      expect(terminal.claimAttempts).toBe(1);
      expect(terminal.verdicts).toHaveLength(1);
      expect(terminal.verdicts[0]?.verdict).toBe("APPROVE");
      expect(terminal.events.map(event => event.eventType)).toEqual(["REVIEW_REQUESTED", "REVIEW_APPROVED"]);

      const auditEvents = await client.auditEvent.findMany({ where: { projectId: seeded.project.id } });
      expect(auditEvents).toHaveLength(1);
      expect(auditEvents[0]?.action).toBe("REVIEW_VERDICT_RECORDED");

      // Relations still resolve correctly across the rebuilt table.
      const terminalWithRelations = await client.reviewRequest.findUniqueOrThrow({
        where: { id: seeded.terminal.id }, include: { project: true, task: true, executionSession: true }
      });
      expect(terminalWithRelations.project.id).toBe(seeded.project.id);
      expect(terminalWithRelations.task.id).toBe(seeded.task.id);
      expect(terminalWithRelations.executionSession.id).toBe(seeded.terminalSession.id);

      // The terminal-immutable and immutable-payload triggers introduced in
      // 2.3A still fire correctly on a row that survived the 2.3B rebuild.
      await expect(client.$executeRawUnsafe('UPDATE "ReviewRequest" SET "status" = ? WHERE "id" = ?', "PENDING", seeded.terminal.id)).rejects.toThrow();

      // A brand-new claude-cli row -- rejected by 2.3A's narrower CHECK -- is now accepted.
      const newSession = await client.executionSession.create({ data: {
        id: randomUUID(), taskId: seeded.task.id, projectId: seeded.project.id, executorId: "codex-cli", status: "SUCCEEDED",
        workspacePath: "C:\\migration-seed\\post", workspaceKey: "migration-seed-post",
        approvedSpecHash: HASH64, approvedExecutor: "CODEX", approvedModel: "AUTO", approvedEffort: "AUTO", approvedReviewer: "CLAUDE",
        approvedPermissionsHash: HASH64, summary: "Codex execution completed."
      } });
      await expect(client.reviewRequest.create({ data: {
        id: randomUUID(), executionSessionId: newSession.id, projectId: seeded.project.id, taskId: seeded.task.id,
        reviewerId: "claude-cli", reviewAuthority: "AUTHORITATIVE", approvalId: seeded.approval.id, approvalStatus: "APPROVED",
        approvalReviewerSelection: "CLAUDE", taskSelectedReviewer: "CLAUDE", executionExecutorId: "codex-cli",
        taskSpecHash: HASH64, approvalSnapshotHash: HASH64, executionCapsuleHash: HASH64, baselineGitEvidenceHash: HASH64,
        finalGitEvidenceHash: HASH64, verificationResultsHash: HASH64, executionArtifactSetHash: HASH64, executionResultStatus: "succeeded",
        finalBranch: "main", finalHead: "cafebabe", reviewPolicyVersion: "2.3A-v1", reviewInputJson: "{}", reviewInputHash: HASH64,
        requestHash: HASH64, reviewerConfigHash: HASH64, requestedBy: "tester"
      } })).resolves.toBeDefined();

      // An invalid reviewer id remains rejected either way.
      await expect(client.reviewRequest.create({ data: {
        id: randomUUID(), executionSessionId: newSession.id, projectId: seeded.project.id, taskId: seeded.task.id,
        reviewerId: "not-a-real-reviewer", reviewAuthority: "AUTHORITATIVE", approvalId: seeded.approval.id, approvalStatus: "APPROVED",
        approvalReviewerSelection: "CLAUDE", taskSelectedReviewer: "CLAUDE", executionExecutorId: "codex-cli",
        taskSpecHash: HASH64, approvalSnapshotHash: HASH64, executionCapsuleHash: HASH64, baselineGitEvidenceHash: HASH64,
        finalGitEvidenceHash: HASH64, verificationResultsHash: HASH64, executionArtifactSetHash: HASH64, executionResultStatus: "succeeded",
        finalBranch: "main", finalHead: "cafebabe", reviewPolicyVersion: "2.3A-v1", reviewInputJson: "{}", reviewInputHash: HASH64,
        requestHash: HASH64, reviewerConfigHash: HASH64, requestedBy: "tester"
      } })).rejects.toThrow();
    } finally {
      await client.$disconnect();
    }
  }, 30_000);

  it("rolls back completely and leaves the original 2.3A schema/data intact when the 2.3B migration is corrupted mid-rebuild", async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "relay-v2-migration-rollback-"));
    const databasePath = path.join(dataDir, "relay-v2.db");
    const env = { ...process.env, RELAY_V2_DATABASE_URL: toPrismaSqliteUrl(databasePath) };

    const alpha23a = await stageSchemaWithMigrations(ALL_MIGRATIONS.slice(0, 4));
    await execFileAsync(process.execPath, [prismaCli, "migrate", "deploy", "--schema", alpha23a.schemaPath], { cwd: repositoryRoot, env, windowsHide: true });

    let seeded: Awaited<ReturnType<typeof seedMilestone23aReviewGraph>>;
    {
      const client = (await createRelayV2Client({ dataDir, testMode: true })).client;
      seeded = await seedMilestone23aReviewGraph(client);
      await client.$disconnect();
    }
    await alpha23a.cleanup();

    // Stage a corrupted copy of the real migrations folder: the 2.3B
    // migration is rewritten to attempt an invalid statement (an INSERT
    // that violates a NOT NULL constraint) partway through the rebuild,
    // deliberately after real DDL has already run inside the same
    // transaction -- proving the whole transaction rolls back, not just the
    // failing statement.
    const corrupted = await stageSchemaWithMigrations(ALL_MIGRATIONS);
    const corruptMigrationPath = path.join(path.dirname(corrupted.schemaPath), "migrations", ALL_MIGRATIONS[4]!, "migration.sql");
    const originalSql = await readFile(corruptMigrationPath, "utf8");
    const corruptedSql = originalSql.replace(
      "COMMIT;\n\nPRAGMA foreign_keys=ON;",
      "INSERT INTO \"ReviewerCapabilitySnapshot\" (\"id\") VALUES ('deliberately-invalid-missing-required-columns');\n\nCOMMIT;\n\nPRAGMA foreign_keys=ON;"
    );
    expect(corruptedSql).not.toBe(originalSql);
    await writeFile(corruptMigrationPath, corruptedSql, "utf8");

    await expect(
      execFileAsync(process.execPath, [prismaCli, "migrate", "deploy", "--schema", corrupted.schemaPath], { cwd: repositoryRoot, env, windowsHide: true })
    ).rejects.toThrow();
    await corrupted.cleanup();

    // Re-open with a client generated against the ORIGINAL (uncorrupted) 2.3A
    // schema shape's expectations: the table must still be exactly the 2.3A
    // ReviewRequest (narrow CHECK), not a half-rebuilt hybrid, and every
    // seeded row must still be there, untouched.
    const client = (await createRelayV2Client({ dataDir, testMode: true })).client;
    try {
      const reviewRequestSql = await client.$queryRawUnsafe<Array<{ sql: string }>>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'ReviewRequest'");
      expect(reviewRequestSql[0]?.sql).toMatch(/"reviewerId" = 'fake-reviewer'/);
      expect(reviewRequestSql[0]?.sql).not.toMatch(/claude-cli/);

      const newTables = await client.$queryRawUnsafe<Array<{ name: string }>>("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('ReviewerCapabilitySnapshot', 'ReviewInvocation')");
      expect(newTables).toHaveLength(0);

      expect((await read23aReviewRequest(client, seeded.active.id)).status).toBe("PENDING");
      const terminal = await read23aReviewRequest(client, seeded.terminal.id);
      expect(terminal.status).toBe("APPROVED");
      expect(terminal.verdicts).toBe(1);
      expect(terminal.events).toBe(2);

      const triggers = await client.$queryRawUnsafe<Array<{ name: string }>>("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'ReviewRequest'");
      expect(triggers.map(trigger => trigger.name)).toEqual(expect.arrayContaining(["ReviewRequest_terminal_immutable", "ReviewRequest_immutable_payload", "ReviewRequest_no_delete"]));
      await expect(client.$executeRawUnsafe('UPDATE "ReviewRequest" SET "status" = ? WHERE "id" = ?', "PENDING", seeded.terminal.id)).rejects.toThrow();

      // Prisma still records the attempted (failed) migration in its own
      // tracking table -- it does not silently omit the row -- but marks it
      // unfinished (`finished_at IS NULL`) rather than applied. The actual
      // database schema/data assertions above are the real proof of
      // rollback; this only confirms Prisma's own bookkeeping agrees the
      // 2.3B migration did not successfully finish.
      const trackedMigrations = await client.$queryRawUnsafe<Array<{ migration_name: string; finished_at: string | null }>>('SELECT migration_name, finished_at FROM "_prisma_migrations" ORDER BY migration_name');
      expect(trackedMigrations.filter(row => row.finished_at !== null).map(row => row.migration_name)).toEqual(ALL_MIGRATIONS.slice(0, 4));
      const failedAttempt = trackedMigrations.find(row => row.migration_name === ALL_MIGRATIONS[4]);
      expect(failedAttempt?.finished_at).toBeNull();

      // The migration can subsequently succeed: repairing Prisma's own
      // tracking state for the failed attempt (Prisma requires explicit
      // resolution rather than silently retrying a migration it recorded as
      // failed) and redeploying the real, uncorrupted migration from the
      // checked-in migrations folder.
      await client.$executeRawUnsafe(`DELETE FROM "_prisma_migrations" WHERE migration_name = '${ALL_MIGRATIONS[4]}'`);
    } finally {
      await client.$disconnect();
    }
    await execFileAsync(process.execPath, [prismaCli, "migrate", "deploy", "--schema", realSchemaPath], { cwd: repositoryRoot, env, windowsHide: true });
    const retriedClient = (await createRelayV2Client({ dataDir, testMode: true })).client;
    const finalMigrations = await retriedClient.$queryRawUnsafe<Array<{ migration_name: string }>>('SELECT migration_name FROM "_prisma_migrations" ORDER BY migration_name');
    expect(finalMigrations.map(row => row.migration_name)).toEqual(ALL_MIGRATIONS);
    const finalReviewRequestSql = await retriedClient.$queryRawUnsafe<Array<{ sql: string }>>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'ReviewRequest'");
    expect(finalReviewRequestSql[0]?.sql).toMatch(/"reviewerId" IN \('fake-reviewer','claude-cli'\)/);
    const preservedTerminal = await retriedClient.reviewRequest.findUniqueOrThrow({ where: { id: seeded.terminal.id } });
    expect(preservedTerminal.status).toBe("APPROVED");
    await retriedClient.$disconnect();
  }, 30_000);

  it("a real dangling foreign key seeded directly in an unmodified 2.3A database makes the unchanged, checked-in 2.3B migration deploy fail and roll back completely", async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "relay-v2-migration-fk-orphan-"));
    const databasePath = path.join(dataDir, "relay-v2.db");
    const env = { ...process.env, RELAY_V2_DATABASE_URL: toPrismaSqliteUrl(databasePath) };

    // 1. Deploy the unchanged, checked-in migrations through 2.3A only.
    const alpha23a = await stageSchemaWithMigrations(ALL_MIGRATIONS.slice(0, 4));
    await execFileAsync(process.execPath, [prismaCli, "migrate", "deploy", "--schema", alpha23a.schemaPath], { cwd: repositoryRoot, env, windowsHide: true });

    let seeded: Awaited<ReturnType<typeof seedMilestone23aReviewGraph>>;
    let orphanId: string;
    let orphanExecutionSessionId: string;
    {
      const client = (await createRelayV2Client({ dataDir, testMode: true })).client;
      seeded = await seedMilestone23aReviewGraph(client);

      // 2/3. Disable foreign keys on this connection (a plain, non-transactional
      // PRAGMA -- SQLite treats PRAGMA foreign_keys as a no-op inside a pending
      // transaction, so this must run standalone) and seed a REAL orphan
      // ReviewRequest row: every CHECK/NOT NULL constraint of the unmodified
      // 2.3A schema is satisfied, and it references a project/task that really
      // exist but an executionSessionId that does not. This is a genuine
      // dangling foreign key already sitting in the database before 2.3B ever
      // runs -- not a corruption injected into the migration script itself.
      orphanId = randomUUID();
      orphanExecutionSessionId = randomUUID();
      await client.$executeRawUnsafe("PRAGMA foreign_keys=OFF");
      await client.$executeRawUnsafe(`
        INSERT INTO "ReviewRequest" (
          "id", "executionSessionId", "projectId", "taskId", "reviewerId", "reviewAuthority",
          "approvalId", "approvalStatus", "approvalReviewerSelection", "taskSelectedReviewer",
          "executionExecutorId", "taskSpecHash", "approvalSnapshotHash", "executionCapsuleHash",
          "baselineGitEvidenceHash", "finalGitEvidenceHash", "verificationResultsHash", "executionArtifactSetHash",
          "executionResultStatus", "finalBranch", "finalHead", "reviewPolicyVersion",
          "reviewInputJson", "reviewInputHash", "requestHash", "reviewerConfigHash", "requestedBy", "updatedAt"
        ) VALUES (
          '${orphanId}', '${orphanExecutionSessionId}', '${seeded.project.id}', '${seeded.task.id}', 'fake-reviewer', 'DIAGNOSTIC',
          '${seeded.approval.id}', 'APPROVED', 'CLAUDE', 'CLAUDE',
          'fake', '${HASH64}', '${HASH64}', '${HASH64}',
          '${HASH64}', '${HASH64}', '${HASH64}', '${HASH64}',
          'succeeded', 'main', 'deadbeef', '2.3A-v1',
          '{}', '${HASH64}', '${HASH64}', '${HASH64}', 'tester', CURRENT_TIMESTAMP
        )
      `);

      // 4. Close the setup connection cleanly.
      await client.$disconnect();
    }
    await alpha23a.cleanup();

    // 5. Run the actual, unchanged Prisma migration deployment containing the real 2.3B migration.
    let deployError: unknown;
    try {
      await execFileAsync(process.execPath, [prismaCli, "migrate", "deploy", "--schema", realSchemaPath], { cwd: repositoryRoot, env, windowsHide: true });
    } catch (error) {
      deployError = error;
    }
    expect(deployError).toBeDefined();
    // 6. The deployment must fail specifically at the FK guard (the
    // CHECK-constrained `_relay_fk_guard` temp table fed from
    // pragma_foreign_key_check), not at some unrelated statement.
    const failureOutput = `${(deployError as { stdout?: string })?.stdout ?? ""}${(deployError as { stderr?: string })?.stderr ?? ""}`;
    expect(failureOutput).toMatch(/_relay_fk_guard|violation_count/);

    // 7. Reopen and verify the original 2.3A schema/data survived untouched.
    const client = (await createRelayV2Client({ dataDir, testMode: true })).client;
    try {
      const reviewRequestSql = await client.$queryRawUnsafe<Array<{ sql: string }>>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'ReviewRequest'");
      expect(reviewRequestSql[0]?.sql).toMatch(/"reviewerId" = 'fake-reviewer'/);
      expect(reviewRequestSql[0]?.sql).not.toMatch(/claude-cli/);

      const newTables = await client.$queryRawUnsafe<Array<{ name: string }>>("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('ReviewerCapabilitySnapshot', 'ReviewInvocation')");
      expect(newTables).toHaveLength(0);

      expect((await read23aReviewRequest(client, seeded.active.id)).status).toBe("PENDING");
      const terminal = await read23aReviewRequest(client, seeded.terminal.id);
      expect(terminal.status).toBe("APPROVED");
      expect(terminal.verdicts).toBe(1);
      expect(terminal.events).toBe(2);
      // The orphan row itself -- the whole point of this test -- also survives untouched.
      expect((await read23aReviewRequest(client, orphanId)).status).toBe("PENDING");

      const triggers = await client.$queryRawUnsafe<Array<{ name: string }>>("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'ReviewRequest'");
      expect(triggers.map(trigger => trigger.name)).toEqual(expect.arrayContaining(["ReviewRequest_terminal_immutable", "ReviewRequest_immutable_payload", "ReviewRequest_no_delete"]));
      await expect(client.$executeRawUnsafe('UPDATE "ReviewRequest" SET "status" = ? WHERE "id" = ?', "PENDING", seeded.terminal.id)).rejects.toThrow();

      const reviewRequestIndexes = await client.$queryRawUnsafe<Array<{ name: string }>>("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'ReviewRequest'");
      expect(reviewRequestIndexes.map(index => index.name)).toEqual(expect.arrayContaining(["ReviewRequest_one_active_execution", "ReviewRequest_status_requestedAt_idx"]));

      // Foreign-key enforcement itself must be back on for the live
      // (fresh, production-style) connection -- PRAGMA foreign_keys=OFF at
      // the top of the failed migration script must not have leaked past
      // its own rollback, and our own setup-connection PRAGMA above only
      // ever applied to that now-closed connection.
      const fkEnforcement = await client.$queryRawUnsafe<Array<{ foreign_keys: number | bigint }>>("PRAGMA foreign_keys");
      expect(Number(fkEnforcement[0]?.foreign_keys)).toBe(1);

      const trackedMigrations = await client.$queryRawUnsafe<Array<{ migration_name: string; finished_at: string | null }>>('SELECT migration_name, finished_at FROM "_prisma_migrations" ORDER BY migration_name');
      expect(trackedMigrations.filter(row => row.finished_at !== null).map(row => row.migration_name)).toEqual(ALL_MIGRATIONS.slice(0, 4));
      const failedAttempt = trackedMigrations.find(row => row.migration_name === ALL_MIGRATIONS[4]);
      expect(failedAttempt?.finished_at).toBeNull();

      // 8. Correct the orphan. ReviewRequest rows can never be deleted
      // (ReviewRequest_no_delete) and executionSessionId is immutable once
      // set (ReviewRequest_immutable_payload), so the only legitimate way to
      // correct a dangling reference is to supply the missing parent row it
      // points to -- create the ExecutionSession the orphan always claimed
      // to reference. (Prisma's own migration tracking also requires
      // clearing the failed attempt before a redeploy.)
      await client.executionSession.create({ data: {
        id: orphanExecutionSessionId, taskId: seeded.task.id, projectId: seeded.project.id, executorId: "fake", status: "SUCCEEDED",
        workspacePath: "C:\\migration-seed\\orphan-fixed", workspaceKey: "migration-seed-orphan-fixed",
        approvedSpecHash: HASH64, approvedExecutor: "FAKE", approvedModel: "AUTO", approvedEffort: "AUTO", approvedReviewer: "CLAUDE",
        approvedPermissionsHash: HASH64, summary: "Fake execution completed."
      } });
      await client.$executeRawUnsafe(`DELETE FROM "_prisma_migrations" WHERE migration_name = '${ALL_MIGRATIONS[4]}'`);
    } finally {
      await client.$disconnect();
    }

    // 9. Re-run the unchanged production migration.
    await execFileAsync(process.execPath, [prismaCli, "migrate", "deploy", "--schema", realSchemaPath], { cwd: repositoryRoot, env, windowsHide: true });

    // 10. Assert success.
    const retriedClient = (await createRelayV2Client({ dataDir, testMode: true })).client;
    const finalMigrations = await retriedClient.$queryRawUnsafe<Array<{ migration_name: string }>>('SELECT migration_name FROM "_prisma_migrations" ORDER BY migration_name');
    expect(finalMigrations.map(row => row.migration_name)).toEqual(ALL_MIGRATIONS);
    const finalReviewRequestSql = await retriedClient.$queryRawUnsafe<Array<{ sql: string }>>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'ReviewRequest'");
    expect(finalReviewRequestSql[0]?.sql).toMatch(/"reviewerId" IN \('fake-reviewer','claude-cli'\)/);
    // The once-orphaned row itself was never deleted (ReviewRequest_no_delete
    // forbids it) -- it survives, now with a real parent ExecutionSession.
    const fixedOrphan = await retriedClient.reviewRequest.findUniqueOrThrow({ where: { id: orphanId } });
    expect(fixedOrphan.executionSessionId).toBe(orphanExecutionSessionId);
    const preservedTerminal = await retriedClient.reviewRequest.findUniqueOrThrow({ where: { id: seeded.terminal.id } });
    expect(preservedTerminal.status).toBe("APPROVED");
    await retriedClient.$disconnect();
  }, 30_000);
});
