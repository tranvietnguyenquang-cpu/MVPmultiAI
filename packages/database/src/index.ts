import { PrismaClient } from "@prisma/client";
import { assertDisposableDatabaseUrl } from "@project-relay/shared";

// Vitest always sets VITEST=true for every worker it spawns (never configurable, so it
// can't be silently skipped); PROJECT_RELAY_TEST_MODE is set explicitly by the Playwright
// config/global-setup for the same reason. Either flag means this process is automated
// tests/verification, not the real dev:local app, so it must never be allowed to construct
// a client against anything but an explicitly disposable database.
if (process.env.VITEST === "true" || process.env.PROJECT_RELAY_TEST_MODE === "true") {
  assertDisposableDatabaseUrl(process.env.DATABASE_URL);
}

const globalDatabase = globalThis as unknown as { prisma?: PrismaClient };
export const prisma = globalDatabase.prisma ?? new PrismaClient();
if (process.env.NODE_ENV !== "production") globalDatabase.prisma = prisma;
export * from "@prisma/client";
export * from "./conversation-service.js";
export * from "./outbox-service.js";
export * from "./auth-service.js";
export * from "./verification-cleanup.js";
