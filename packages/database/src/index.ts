import { PrismaClient } from "@prisma/client";

const globalDatabase = globalThis as unknown as { prisma?: PrismaClient };
export const prisma = globalDatabase.prisma ?? new PrismaClient();
if (process.env.NODE_ENV !== "production") globalDatabase.prisma = prisma;
export * from "@prisma/client";
export * from "./conversation-service.js";
export * from "./outbox-service.js";
export * from "./auth-service.js";
