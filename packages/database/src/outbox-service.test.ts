import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "./index.js";
import { queueConversationMessage } from "./conversation-service.js";
import { calculateOutboxRetryDelay, dispatchPendingOutboxEvents, getOutboxEventByJobId, recoverStuckOutboxEvents, sanitizeOutboxError } from "./outbox-service.js";

describe("transactional outbox", () => {
  let projectId: string;

  beforeAll(async () => {
    const project = await prisma.project.create({
      data: { name: `outbox-test-${randomUUID()}`, repositoryPath: `/tmp/outbox-test-${randomUUID()}`, allowedCommands: [], permittedPaths: [] }
    });
    projectId = project.id;
  });

  afterAll(async () => {
    const sessions = await prisma.agentSession.findMany({ where: { projectId }, select: { id: true } });
    await prisma.outboxEvent.deleteMany({ where: { jobId: { in: sessions.map(session => session.id) } } }).catch(() => undefined);
    await prisma.project.delete({ where: { id: projectId } }).catch(() => undefined);
  });

  async function newConversation(title: string) {
    return prisma.conversation.create({ data: { projectId, title } });
  }

  async function queueTestMessage(conversationId: string, content = "hello") {
    return queueConversationMessage({
      conversationId,
      projectId,
      content,
      mode: "ASK",
      selectedProviderId: "codex-cli",
      reason: "test",
      providerHealthSnapshot: {},
      previousAssistantMessage: null,
      idempotencyKey: randomUUID()
    });
  }

  it("creates the outbox row atomically with the rest of the orchestration (no separate publish step)", async () => {
    const conversation = await newConversation("Atomic outbox creation");
    const result = await queueTestMessage(conversation.id);

    const outboxEvent = await getOutboxEventByJobId(result.agentSession.id);
    expect(outboxEvent).not.toBeNull();
    expect(outboxEvent?.status).toBe("PENDING");
    expect(outboxEvent?.topic).toBe("conversation-message");
    // The stable job ID is the agent session ID, matching what the real BullMQ job will use.
    expect(outboxEvent?.jobId).toBe(result.agentSession.id);
  });

  it("does not create an outbox event (or any other row) when the database transaction rolls back", async () => {
    const before = await prisma.outboxEvent.count();
    await expect(
      queueConversationMessage({
        conversationId: "does-not-exist",
        projectId,
        content: "hello",
        mode: "ASK",
        selectedProviderId: "codex-cli",
        reason: "test",
        providerHealthSnapshot: {},
        previousAssistantMessage: null,
        idempotencyKey: randomUUID()
      })
    ).rejects.toThrow();
    const after = await prisma.outboxEvent.count();
    expect(after).toBe(before);
  });

  it("does not leave a permanently queued database record without a corresponding outbox path", async () => {
    const conversation = await newConversation("No orphan queued record");
    const result = await queueTestMessage(conversation.id);
    // Every AgentSession created by queueConversationMessage must have a matching outbox event
    // with the same jobId; there is no code path that creates one without the other.
    const outboxEvent = await getOutboxEventByJobId(result.agentSession.id);
    expect(outboxEvent).not.toBeNull();
    expect(result.agentSession.state).toBe("QUEUED");
  });

  it("keeps the execution durable while Redis is simulated as unavailable, and recovers once it is reachable again (delayed commit / temporary Redis outage)", async () => {
    const conversation = await newConversation("Redis unavailable then recovery");
    const result = await queueTestMessage(conversation.id);

    // Redis down: publish fails, but the DB record already committed durably (it happened
    // before this dispatch call even runs), so no execution is lost.
    const failingPublish = vi.fn(async () => { throw new Error("ECONNREFUSED: Redis unavailable"); });
    const firstAttempt = await dispatchPendingOutboxEvents(failingPublish, 20, { jobId: result.agentSession.id });
    const failedResult = firstAttempt.find(item => item.jobId === result.agentSession.id);
    expect(failedResult?.status).toBe("failed");

    let stored = await getOutboxEventByJobId(result.agentSession.id);
    expect(stored?.status).toBe("FAILED");
    expect(stored?.lastErrorCode).toBe("REDIS_UNAVAILABLE");

    // Redis recovers: the same event is retried and this time succeeds.
    const recoveredPublish = vi.fn(async () => undefined);
    const secondAttempt = await dispatchPendingOutboxEvents(recoveredPublish, 20, { jobId: result.agentSession.id }, { now: () => new Date(stored!.nextAttemptAt.getTime() + 1) });
    const recoveredResult = secondAttempt.find(item => item.jobId === result.agentSession.id);
    expect(recoveredResult?.status).toBe("published");
    expect(recoveredPublish).toHaveBeenCalledTimes(1);

    stored = await getOutboxEventByJobId(result.agentSession.id);
    expect(stored?.status).toBe("PUBLISHED");
    expect(stored?.publishedAt).not.toBeNull();
  });

  it("publishes with a stable, deterministic job ID across retries", async () => {
    const conversation = await newConversation("Stable job ID");
    const result = await queueTestMessage(conversation.id);

    const capturedJobIds: string[] = [];
    const failThenSucceed = vi.fn(async (event: { jobId: string }) => {
      capturedJobIds.push(event.jobId);
      if (capturedJobIds.length === 1) throw new Error("transient failure");
    });

    await dispatchPendingOutboxEvents(failThenSucceed, 20, { jobId: result.agentSession.id });
    const failed = await getOutboxEventByJobId(result.agentSession.id);
    await dispatchPendingOutboxEvents(failThenSucceed, 20, { jobId: result.agentSession.id }, { now: () => new Date(failed!.nextAttemptAt.getTime() + 1) });

    expect(capturedJobIds).toEqual([result.agentSession.id, result.agentSession.id]);
  });

  it("is safe under a duplicate/concurrent dispatcher execution (no double publish)", async () => {
    const conversation = await newConversation("Duplicate dispatcher execution");
    const result = await queueTestMessage(conversation.id);

    const scope = { jobId: result.agentSession.id };
    const publish = vi.fn(async () => undefined);
    const [first, second] = await Promise.all([dispatchPendingOutboxEvents(publish, 20, scope), dispatchPendingOutboxEvents(publish, 20, scope)]);

    const publishedCount = [...first, ...second].filter(item => item.jobId === result.agentSession.id && item.status === "published").length;
    expect(publishedCount).toBe(1);
    expect(publish).toHaveBeenCalledTimes(1);

    const stored = await getOutboxEventByJobId(result.agentSession.id);
    expect(stored?.status).toBe("PUBLISHED");
    expect(stored?.attempts).toBe(1);
  });

  it("recovers rows stuck in DISPATCHING after a dispatcher restart", async () => {
    const conversation = await newConversation("Dispatcher restart recovery");
    const result = await queueTestMessage(conversation.id);

    // Simulate a dispatcher that claimed the row (DISPATCHING) and then crashed before publishing.
    await prisma.outboxEvent.update({
      where: { jobId: result.agentSession.id },
      data: { status: "DISPATCHING", updatedAt: new Date(Date.now() - 120_000) }
    });

    const recovered = await recoverStuckOutboxEvents(60_000);
    expect(recovered.count).toBeGreaterThanOrEqual(1);

    const afterRecovery = await getOutboxEventByJobId(result.agentSession.id);
    expect(afterRecovery?.status).toBe("PENDING");

    const publish = vi.fn(async () => undefined);
    const dispatched = await dispatchPendingOutboxEvents(publish, 20, { jobId: result.agentSession.id });
    expect(dispatched.find(item => item.jobId === result.agentSession.id)?.status).toBe("published");
  });

  it("does not recover DISPATCHING rows that are still fresh (dispatcher actively working)", async () => {
    const conversation = await newConversation("Fresh dispatching row left alone");
    const result = await queueTestMessage(conversation.id);
    await prisma.outboxEvent.update({ where: { jobId: result.agentSession.id }, data: { status: "DISPATCHING" } });

    await recoverStuckOutboxEvents(60_000);
    const stillDispatching = await getOutboxEventByJobId(result.agentSession.id);
    expect(stillDispatching?.status).toBe("DISPATCHING");
  });

  it("persists a future retry time and does not busy-loop while Redis is unavailable", async () => {
    const conversation = await newConversation("Backoff scheduling");
    const result = await queueTestMessage(conversation.id);
    const now = new Date("2026-07-25T00:00:00.000Z");
    const publish = vi.fn(async () => { throw new Error("ECONNREFUSED redis://user:password@localhost:6379/0"); });

    await dispatchPendingOutboxEvents(publish, 20, { jobId: result.agentSession.id }, { now: () => now, jitter: () => 0.5 });
    const failed = await getOutboxEventByJobId(result.agentSession.id);
    expect(failed?.attempts).toBe(1);
    expect(failed?.nextAttemptAt.getTime()).toBe(now.getTime() + 5_000);

    await dispatchPendingOutboxEvents(publish, 20, { jobId: result.agentSession.id }, { now: () => new Date(now.getTime() + 4_999) });
    expect(publish).toHaveBeenCalledTimes(1);

    await dispatchPendingOutboxEvents(publish, 20, { jobId: result.agentSession.id }, { now: () => new Date(now.getTime() + 5_000), jitter: () => 0.5 });
    const secondFailure = await getOutboxEventByJobId(result.agentSession.id);
    expect(secondFailure?.attempts).toBe(2);
    expect(secondFailure?.nextAttemptAt.getTime()).toBe(now.getTime() + 15_000);
  });

  it("uses bounded exponential backoff with bounded jitter", () => {
    const policy = { baseDelayMs: 5_000, maxDelayMs: 15_000, maxAttempts: 10, jitterPercent: 0.1 };
    expect(calculateOutboxRetryDelay(1, policy, () => 0)).toBe(4_500);
    expect(calculateOutboxRetryDelay(2, policy, () => 1)).toBe(11_000);
    expect(calculateOutboxRetryDelay(10, policy, () => 1)).toBe(15_000);
  });

  it("preserves retry timing and attempt count across dispatcher restart recovery", async () => {
    const conversation = await newConversation("Retry restart persistence");
    const result = await queueTestMessage(conversation.id);
    const now = new Date("2026-07-25T01:00:00.000Z");
    await dispatchPendingOutboxEvents(async () => { throw new Error("temporary"); }, 20, { jobId: result.agentSession.id }, { now: () => now, jitter: () => 0.5 });
    const before = await getOutboxEventByJobId(result.agentSession.id);
    await prisma.outboxEvent.update({ where: { jobId: result.agentSession.id }, data: { status: "DISPATCHING", updatedAt: new Date(now.getTime() - 120_000) } });
    await recoverStuckOutboxEvents(60_000, now);
    const after = await getOutboxEventByJobId(result.agentSession.id);
    expect(after?.attempts).toBe(before?.attempts);
    expect(after?.nextAttemptAt).toEqual(before?.nextAttemptAt);
  });

  it("moves an event to DEAD_LETTER at maximum attempts and never retries it", async () => {
    const conversation = await newConversation("Dead letter");
    const result = await queueTestMessage(conversation.id);
    const now = new Date("2026-07-25T02:00:00.000Z");
    const publish = vi.fn(async () => { throw new Error("permanent failure"); });
    const dispatched = await dispatchPendingOutboxEvents(publish, 20, { jobId: result.agentSession.id }, { now: () => now, policy: { maxAttempts: 1 }, jitter: () => 0.5 });
    expect(dispatched[0]?.status).toBe("dead-letter");
    const deadLetter = await getOutboxEventByJobId(result.agentSession.id);
    expect(deadLetter?.status).toBe("DEAD_LETTER");
    await dispatchPendingOutboxEvents(publish, 20, { jobId: result.agentSession.id }, { now: () => new Date(now.getTime() + 86_400_000) });
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("sanitizes connection strings, credentials, and filesystem paths before persisting errors", async () => {
    const error = sanitizeOutboxError(new Error("redis://alice:secret@host:6379/0 token=abc123 C:\\Users\\alice\\token.txt /srv/private/.env"));
    expect(error.message).not.toContain("secret");
    expect(error.message).not.toContain("abc123");
    expect(error.message).not.toContain("C:\\Users");
    expect(error.message).not.toContain("/srv/private");
  });
});
