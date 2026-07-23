import { randomBytes } from "node:crypto";
import { prisma } from "./index.js";

export async function createLocalSession() {
  const token = randomBytes(32).toString("base64url");
  return prisma.localSession.create({ data: { token } });
}

export async function getValidLocalSession(token: string | undefined | null) {
  if (!token) return null;
  const session = await prisma.localSession.findUnique({ where: { token } });
  if (!session || session.revokedAt) return null;
  await prisma.localSession.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } });
  return session;
}

export const revokeLocalSession = (token: string) => prisma.localSession.updateMany({ where: { token, revokedAt: null }, data: { revokedAt: new Date() } });
