import { Prisma, prisma } from "./index.js";

export type OutboxEventInput = { topic: string; jobId: string; payload: Record<string, unknown> };
export type OutboxRetryPolicy = {
  baseDelayMs: number;
  maxDelayMs: number;
  maxAttempts: number;
  jitterPercent: number;
};

export type OutboxDispatchDependencies = {
  now?: () => Date;
  jitter?: () => number;
  policy?: Partial<OutboxRetryPolicy>;
};

const boundedNumber = (value: string | undefined, fallback: number, min: number, max: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
};

export const defaultOutboxRetryPolicy: OutboxRetryPolicy = {
  baseDelayMs: boundedNumber(process.env.PROJECT_RELAY_OUTBOX_BASE_DELAY_MS, 5_000, 1_000, 900_000),
  maxDelayMs: boundedNumber(process.env.PROJECT_RELAY_OUTBOX_MAX_DELAY_MS, 900_000, 1_000, 3_600_000),
  maxAttempts: boundedNumber(process.env.PROJECT_RELAY_OUTBOX_MAX_ATTEMPTS, 10, 1, 100),
  jitterPercent: boundedNumber(process.env.PROJECT_RELAY_OUTBOX_JITTER_PERCENT, 0.1, 0, 0.25)
};
defaultOutboxRetryPolicy.maxDelayMs = Math.max(defaultOutboxRetryPolicy.baseDelayMs, defaultOutboxRetryPolicy.maxDelayMs);

export function resolveOutboxRetryPolicy(overrides: Partial<OutboxRetryPolicy> = {}): OutboxRetryPolicy {
  const policy = { ...defaultOutboxRetryPolicy, ...overrides };
  return {
    baseDelayMs: Math.min(900_000, Math.max(1_000, policy.baseDelayMs)),
    maxDelayMs: Math.min(3_600_000, Math.max(policy.baseDelayMs, policy.maxDelayMs)),
    maxAttempts: Math.min(100, Math.max(1, policy.maxAttempts)),
    jitterPercent: Math.min(0.25, Math.max(0, policy.jitterPercent))
  };
}

/** Calculates a bounded exponential retry delay. `jitter` returns a value in [0, 1]. */
export function calculateOutboxRetryDelay(attemptCount: number, policy: OutboxRetryPolicy, jitter = Math.random): number {
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, attemptCount - 1));
  const factor = 1 - policy.jitterPercent + (2 * policy.jitterPercent * Math.min(1, Math.max(0, jitter())));
  return Math.round(Math.min(policy.maxDelayMs, Math.max(1_000, exponential * factor)));
}

/** Public-safe, bounded diagnostic text for persisted retry state. */
export function sanitizeOutboxError(error: unknown): { code: string; message: string } {
  const raw = error instanceof Error ? error.message : "Publish failed";
  const code = /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|redis/i.test(raw) ? "REDIS_UNAVAILABLE" : "PUBLISH_FAILED";
  const message = raw
    .replace(/\b(?:redis|rediss|postgres|postgresql):\/\/[^\s'"`]+/gi, "[connection redacted]")
    .replace(/\b(?:api[ _-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\b[A-Za-z]:\\[^\s'"`]+/g, "[path redacted]")
    .replace(/(?:^|\s)\/(?:[^\s'"`]+)/g, " [path redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
  return { code, message: message || "Publish failed" };
}

export function createOutboxEventWithClient(client: Prisma.TransactionClient, input: OutboxEventInput) {
  return client.outboxEvent.create({ data: { topic: input.topic, jobId: input.jobId, payload: input.payload as Prisma.InputJsonValue } });
}

/** Resets rows stuck in DISPATCHING after a crash while retaining their persisted retry schedule. */
export async function recoverStuckOutboxEvents(olderThanMs = 60_000, now = new Date()) {
  const cutoff = new Date(now.getTime() - olderThanMs);
  return prisma.outboxEvent.updateMany({ where: { status: "DISPATCHING", updatedAt: { lt: cutoff } }, data: { status: "PENDING" } });
}

async function claimOutboxEvent(id: string, now: Date): Promise<boolean> {
  const claimed = await prisma.outboxEvent.updateMany({
    where: { id, status: { in: ["PENDING", "FAILED"] }, nextAttemptAt: { lte: now } },
    data: { status: "DISPATCHING" }
  });
  return claimed.count === 1;
}

export type OutboxPublishFn = (event: { topic: string; jobId: string; payload: unknown }) => Promise<unknown>;
export type OutboxDispatchResult = { id: string; jobId: string; status: "published" | "failed" | "dead-letter" | "skipped"; error?: string };

/**
 * Claims due events before publishing. The compare-and-swap claim is the mutual-exclusion
 * boundary, so concurrent dispatchers cannot publish an event twice.
 */
export async function dispatchPendingOutboxEvents(
  publish: OutboxPublishFn,
  limit = 20,
  extraWhere: Prisma.OutboxEventWhereInput = {},
  dependencies: OutboxDispatchDependencies = {}
): Promise<OutboxDispatchResult[]> {
  const now = dependencies.now?.() ?? new Date();
  const policy = resolveOutboxRetryPolicy(dependencies.policy);
  const pending = await prisma.outboxEvent.findMany({
    where: { status: { in: ["PENDING", "FAILED"] }, nextAttemptAt: { lte: now }, ...extraWhere },
    orderBy: [{ nextAttemptAt: "asc" }, { createdAt: "asc" }],
    take: limit
  });
  const results: OutboxDispatchResult[] = [];
  for (const event of pending) {
    if (!(await claimOutboxEvent(event.id, now))) {
      results.push({ id: event.id, jobId: event.jobId, status: "skipped" });
      continue;
    }
    try {
      await publish({ topic: event.topic, jobId: event.jobId, payload: event.payload });
      await prisma.outboxEvent.update({
        where: { id: event.id },
        data: { status: "PUBLISHED", publishedAt: now, nextAttemptAt: now, attempts: { increment: 1 }, lastErrorCode: null, lastErrorMessage: null }
      });
      results.push({ id: event.id, jobId: event.jobId, status: "published" });
    } catch (error) {
      const safe = sanitizeOutboxError(error);
      const attemptCount = event.attempts + 1;
      const deadLetter = attemptCount >= policy.maxAttempts;
      const delay = calculateOutboxRetryDelay(attemptCount, policy, dependencies.jitter);
      await prisma.outboxEvent.update({
        where: { id: event.id },
        data: {
          status: deadLetter ? "DEAD_LETTER" : "FAILED",
          nextAttemptAt: new Date(now.getTime() + delay),
          lastErrorCode: safe.code,
          lastErrorMessage: safe.message,
          attempts: { increment: 1 }
        }
      });
      results.push({ id: event.id, jobId: event.jobId, status: deadLetter ? "dead-letter" : "failed", error: safe.message });
    }
  }
  return results;
}

export const getOutboxEventByJobId = (jobId: string) => prisma.outboxEvent.findUnique({ where: { jobId } });
export const listOutboxEvents = (where: Parameters<typeof prisma.outboxEvent.findMany>[0] = {}) => prisma.outboxEvent.findMany(where);
