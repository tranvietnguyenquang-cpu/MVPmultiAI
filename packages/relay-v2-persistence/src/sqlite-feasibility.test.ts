import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RelayV2Database } from "./client.js";
import { createRelayV2Client } from "./client.js";
import { createDisposableRelayV2Database } from "./testing.js";

describe("Prisma SQLite Milestone 1 feasibility", () => {
  let database: Awaited<ReturnType<typeof createDisposableRelayV2Database>>;
  let client: RelayV2Database;

  beforeAll(async () => {
    database = await createDisposableRelayV2Database();
    client = database.client;
  }, 30_000);

  afterAll(async () => database.cleanup());

  function projectData(suffix = randomUUID()) {
    return { id: randomUUID(), name: `Project ${suffix}`, slug: `project-${suffix}`, localPath: `C:\\work\\${suffix}`, pathKey: `c:/work/${suffix}` };
  }

  it("applies the checked-in migration and enables foreign keys, WAL, and a busy timeout", async () => {
    const migrations = await client.$queryRawUnsafe<Array<{ migration_name: string }>>('SELECT migration_name FROM "_prisma_migrations"');
    expect(migrations.map(item => item.migration_name)).toContain("20260801000000_milestone1_init");
    const foreignKeys = await client.$queryRawUnsafe<Array<{ foreign_keys: bigint }>>("PRAGMA foreign_keys");
    const journal = await client.$queryRawUnsafe<Array<{ journal_mode: string }>>("PRAGMA journal_mode");
    const busy = await client.$queryRawUnsafe<Array<{ timeout: bigint }>>("PRAGMA busy_timeout");
    expect(Number(foreignKeys[0]?.foreign_keys)).toBe(1);
    expect(journal[0]?.journal_mode.toLowerCase()).toBe("wal");
    expect(Number(busy[0]?.timeout)).toBe(5_000);
  });

  it("enforces foreign keys", async () => {
    await expect(client.task.create({ data: {
      id: randomUUID(), projectId: "missing", idempotencyKey: randomUUID(), title: "x", objective: "x", source: "MANUAL", taskType: "OTHER", complexity: "NORMAL", status: "PENDING_APPROVAL", specHash: "x", normalizedSpecJson: "{}"
    } })).rejects.toThrow();
  });

  it("rolls back transactions atomically", async () => {
    const data = projectData();
    await expect(client.$transaction(async tx => {
      await tx.project.create({ data });
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    expect(await client.project.findUnique({ where: { id: data.id } })).toBeNull();
  });

  it("enforces unique indexes under concurrent access", async () => {
    const first = projectData();
    const secondClient = (await createRelayV2Client({ dataDir: database.paths.dataDir, testMode: true })).client;
    const results = await Promise.allSettled([
      client.project.create({ data: first }),
      secondClient.project.create({ data: { ...projectData(), slug: first.slug } })
    ]);
    await secondClient.$disconnect();
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
  });

  it("round-trips timestamps", async () => {
    const project = await client.project.create({ data: projectData() });
    expect(project.createdAt).toBeInstanceOf(Date);
    expect(project.updatedAt).toBeInstanceOf(Date);
  });

  it("uses checked strings for enum-like data and checked canonical JSON text", async () => {
    const project = await client.project.create({ data: projectData() });
    await expect(client.$executeRawUnsafe(`INSERT INTO Task (id, projectId, idempotencyKey, title, objective, source, taskType, complexity, status, specHash, normalizedSpecJson, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`, randomUUID(), project.id, randomUUID(), "x", "x", "MANUAL", "OTHER", "NORMAL", "NOT_A_STATUS", "hash", "{}" )).rejects.toThrow();
    await expect(client.$executeRawUnsafe(`INSERT INTO Task (id, projectId, idempotencyKey, title, objective, source, taskType, complexity, status, specHash, normalizedSpecJson, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`, randomUUID(), project.id, randomUUID(), "x", "x", "MANUAL", "OTHER", "NORMAL", "PENDING_APPROVAL", "hash", "not-json" )).rejects.toThrow();
  });

  it("makes audit events append-only", async () => {
    const project = await client.project.create({ data: projectData() });
    const audit = await client.auditEvent.create({ data: { id: randomUUID(), projectId: project.id, actor: "test", action: "PROJECT_CREATED", riskLevel: "SAFE", detailsJson: "{}" } });
    await expect(client.auditEvent.update({ where: { id: audit.id }, data: { actor: "changed" } })).rejects.toThrow(/append-only/i);
    await expect(client.auditEvent.delete({ where: { id: audit.id } })).rejects.toThrow(/append-only/i);
  });
});
