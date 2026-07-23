import { Prisma, prisma } from "./index.js";

export type OutboxEventInput = { topic: string; jobId: string; payload: Record<string, unknown> };

export function createOutboxEventWithClient(client: Prisma.TransactionClient, input: OutboxEventInput) {
  return client.outboxEvent.create({ data: { topic: input.topic, jobId: input.jobId, payload: input.payload as Prisma.InputJsonValue } });
}

/** Resets rows stuck in DISPATCHING (e.g. after a dispatcher crash) back to PENDING so they can be retried. */
export async function recoverStuckOutboxEvents(olderThanMs = 60_000) {
  const cutoff = new Date(Date.now() - olderThanMs);
  return prisma.outboxEvent.updateMany({ where: { status: "DISPATCHING", updatedAt: { lt: cutoff } }, data: { status: "PENDING" } });
}

async function claimOutboxEvent(id: string): Promise<boolean> {
  const claimed = await prisma.outboxEvent.updateMany({ where: { id, status: { in: ["PENDING", "FAILED"] } }, data: { status: "DISPATCHING" } });
  return claimed.count === 1;
}

export type OutboxPublishFn = (event: { topic: string; jobId: string; payload: unknown }) => Promise<unknown>;
export type OutboxDispatchResult = { id: string; jobId: string; status: "published" | "failed" | "skipped"; error?: string };

/**
 * Claims and publishes pending (or previously failed) outbox events one at a time.
 * The DB-level claim (PENDING/FAILED -> DISPATCHING) is the sole mutual-exclusion mechanism,
 * so concurrent dispatcher instances can call this safely without double-publishing.
 */
export async function dispatchPendingOutboxEvents(publish: OutboxPublishFn, limit = 20, extraWhere: Prisma.OutboxEventWhereInput = {}): Promise<OutboxDispatchResult[]> {
  const pending = await prisma.outboxEvent.findMany({ where: { status: { in: ["PENDING", "FAILED"] }, ...extraWhere }, orderBy: { createdAt: "asc" }, take: limit });
  const results: OutboxDispatchResult[] = [];
  for (const event of pending) {
    const claimed = await claimOutboxEvent(event.id);
    if (!claimed) {
      results.push({ id: event.id, jobId: event.jobId, status: "skipped" });
      continue;
    }
    try {
      await publish({ topic: event.topic, jobId: event.jobId, payload: event.payload });
      await prisma.outboxEvent.update({ where: { id: event.id }, data: { status: "PUBLISHED", publishedAt: new Date(), attempts: { increment: 1 } } });
      results.push({ id: event.id, jobId: event.jobId, status: "published" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Publish failed";
      await prisma.outboxEvent.update({ where: { id: event.id }, data: { status: "FAILED", lastError: message, attempts: { increment: 1 } } });
      results.push({ id: event.id, jobId: event.jobId, status: "failed", error: message });
    }
  }
  return results;
}

export const getOutboxEventByJobId = (jobId: string) => prisma.outboxEvent.findUnique({ where: { jobId } });
export const listOutboxEvents = (where: Parameters<typeof prisma.outboxEvent.findMany>[0] = {}) => prisma.outboxEvent.findMany(where);
