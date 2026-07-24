import { Redis } from "ioredis";
import { assertDisposableDatabaseUrl, assertDisposableRedisUrl } from "@project-relay/shared";
import { ensureDisposablePostgresDatabase, migrateDisposableDatabase } from "./ensure-disposable-database.mjs";

/** Only ever called after assertDisposableRedisUrl has passed - flushes the dedicated, single-purpose disposable Redis instance so leftover job keys from an interrupted prior run never leak into a fresh one. */
async function flushDisposableRedis(redisUrl: string): Promise<void> {
  const client = new Redis(redisUrl, { maxRetriesPerRequest: 1, lazyConnect: true });
  try {
    await client.connect();
    await client.flushdb();
  } finally {
    client.disconnect();
  }
}

/**
 * Runs once for the whole `vitest run` before any test file executes. Fails the entire run
 * before a single test can mutate anything if the resolved database/Redis are not
 * explicitly disposable (belt-and-suspenders on top of the same check in
 * packages/database/src/index.ts and apps/web/lib/redis.ts), then provisions and migrates
 * the disposable database and sweeps up any verification-owned rows a previous interrupted
 * run left behind, so every run starts from a known-clean slate.
 */
export default async function setup(): Promise<() => Promise<void>> {
  assertDisposableDatabaseUrl(process.env.DATABASE_URL);
  assertDisposableRedisUrl(process.env.REDIS_URL);

  const databaseName = decodeURIComponent(new URL(process.env.DATABASE_URL!).pathname.replace(/^\//, ""));
  await ensureDisposablePostgresDatabase(databaseName);
  await migrateDisposableDatabase(process.env.DATABASE_URL!);
  await flushDisposableRedis(process.env.REDIS_URL!);

  const { prisma, commitVerificationCleanup } = await import("@project-relay/database");
  await commitVerificationCleanup();
  await prisma.$disconnect();

  return async function teardown(): Promise<void> {
    const { prisma: closingPrisma, commitVerificationCleanup: commit, previewVerificationCleanup: preview } = await import("@project-relay/database");
    await commit();
    const remaining = await preview();
    if (remaining.counts.projects > 0) {
      await closingPrisma.$disconnect();
      throw new Error(`Verification cleanup left ${remaining.counts.projects} project(s) behind after the test run; teardown must not silently pass.`);
    }
    await closingPrisma.$disconnect();
  };
}
