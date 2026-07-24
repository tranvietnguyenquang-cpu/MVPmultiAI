import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma, queueConversationMessage } from "@project-relay/database";
import { claimAgentSession, reapExpiredAgentSessions, startHeartbeat } from "./worker-lease.js";

describe("worker ownership, leases, and safe crash recovery", () => {
  let projectId: string;

  beforeAll(async () => {
    const project = await prisma.project.create({
      data: { name: `worker-lease-test-${randomUUID()}`, repositoryPath: `/tmp/worker-lease-test-${randomUUID()}`, allowedCommands: [], permittedPaths: [], isVerification: true }
    });
    projectId = project.id;
  });

  afterAll(async () => {
    // ConversationMessage.taskId is RESTRICT, and the assistant messages created here
    // reference the auto-created Task, so clear messages before deleting the project.
    const conversations = await prisma.conversation.findMany({ where: { projectId }, select: { id: true } });
    await prisma.conversationMessage.deleteMany({ where: { conversationId: { in: conversations.map(c => c.id) } } });
    await prisma.project.delete({ where: { id: projectId } }).catch(() => undefined);
  });

  async function queueSession(title: string) {
    const conversation = await prisma.conversation.create({ data: { projectId, title } });
    const result = await queueConversationMessage({
      conversationId: conversation.id,
      projectId,
      content: "hello",
      mode: "ASK",
      selectedProviderId: "codex-cli",
      reason: "test routing",
      providerHealthSnapshot: {},
      previousAssistantMessage: null,
      idempotencyKey: randomUUID()
    });
    if (result.duplicate) throw new Error("Expected a fresh (non-duplicate) queue result.");
    return { conversation, sessionId: result.agentSession.id, providerSessionId: result.providerSession.id };
  }

  describe("claimAgentSession", () => {
    it("claims a QUEUED session, recording the worker id and a future lease", async () => {
      const { sessionId } = await queueSession("Claim success");
      const claimed = await claimAgentSession(sessionId, "worker-A", 60_000);
      expect(claimed).toBe(true);

      const session = await prisma.agentSession.findUniqueOrThrow({ where: { id: sessionId } });
      expect(session.state).toBe("STARTING");
      expect(session.workerId).toBe("worker-A");
      expect(session.leaseExpiresAt).not.toBeNull();
      expect(session.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now());

      await prisma.agentSession.update({ where: { id: sessionId }, data: { state: "CANCELLED", leaseExpiresAt: null } });
    });

    it("refuses to claim a session that is not QUEUED (already claimed by another worker)", async () => {
      const { sessionId } = await queueSession("Claim race");
      expect(await claimAgentSession(sessionId, "worker-A", 60_000)).toBe(true);
      expect(await claimAgentSession(sessionId, "worker-B", 60_000)).toBe(false);

      const session = await prisma.agentSession.findUniqueOrThrow({ where: { id: sessionId } });
      expect(session.workerId).toBe("worker-A");

      await prisma.agentSession.update({ where: { id: sessionId }, data: { state: "CANCELLED", leaseExpiresAt: null } });
    });
  });

  describe("startHeartbeat", () => {
    // The heartbeat interval floors at 1000ms regardless of leaseMs (no sub-second DB
    // polling), so these waits must clear that floor to observe an actual tick.
    const TICK_WAIT_MS = 1_300;

    it("renews the lease periodically and stops renewing once released", async () => {
      const { sessionId } = await queueSession("Heartbeat renewal");
      await claimAgentSession(sessionId, "worker-A", 3_000);
      const before = (await prisma.agentSession.findUniqueOrThrow({ where: { id: sessionId } })).leaseExpiresAt!;

      const stop = startHeartbeat(sessionId, "worker-A", 3_000);
      await new Promise(resolve => setTimeout(resolve, TICK_WAIT_MS));
      const during = (await prisma.agentSession.findUniqueOrThrow({ where: { id: sessionId } })).leaseExpiresAt!;
      expect(during.getTime()).toBeGreaterThan(before.getTime());

      stop();
      const afterStop = (await prisma.agentSession.findUniqueOrThrow({ where: { id: sessionId } })).leaseExpiresAt!;
      await new Promise(resolve => setTimeout(resolve, TICK_WAIT_MS));
      const stillAfterStop = (await prisma.agentSession.findUniqueOrThrow({ where: { id: sessionId } })).leaseExpiresAt!;
      expect(stillAfterStop.getTime()).toBe(afterStop.getTime());

      await prisma.agentSession.update({ where: { id: sessionId }, data: { state: "CANCELLED", leaseExpiresAt: null } });
    }, 10_000);

    it("does not renew a lease it no longer owns (workerId mismatch)", async () => {
      const { sessionId } = await queueSession("Heartbeat ownership guard");
      await claimAgentSession(sessionId, "worker-A", 3_000);
      const before = (await prisma.agentSession.findUniqueOrThrow({ where: { id: sessionId } })).leaseExpiresAt!;

      const stop = startHeartbeat(sessionId, "worker-B", 3_000); // wrong owner
      await new Promise(resolve => setTimeout(resolve, TICK_WAIT_MS));
      stop();

      const session = await prisma.agentSession.findUniqueOrThrow({ where: { id: sessionId } });
      expect(session.workerId).toBe("worker-A"); // untouched by the impostor heartbeat
      expect(session.leaseExpiresAt!.getTime()).toBe(before.getTime()); // never extended by worker-B

      await prisma.agentSession.update({ where: { id: sessionId }, data: { state: "CANCELLED", leaseExpiresAt: null } });
    }, 10_000);
  });

  describe("reapExpiredAgentSessions", () => {
    it("never touches a session whose lease is still live (a second worker must not fail work owned by a live worker)", async () => {
      const { sessionId } = await queueSession("Live lease untouched");
      const before = await claimAgentSession(sessionId, "worker-A", 60_000); // lease far in the future
      expect(before).toBe(true);

      // The sweep is process-wide by design (a second worker's startup recovery scans
      // every session, not just its own), so assert on this specific session rather than
      // a global reaped count that could include unrelated sessions in a shared test DB.
      await reapExpiredAgentSessions();

      const session = await prisma.agentSession.findUniqueOrThrow({ where: { id: sessionId } });
      expect(session.state).toBe("STARTING");
      expect(session.workerId).toBe("worker-A");
      expect(session.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now());

      await prisma.agentSession.update({ where: { id: sessionId }, data: { state: "CANCELLED", leaseExpiresAt: null } });
    });

    it("reclaims a session whose lease has expired, keeping AgentSession/ProviderSession/ConversationMessage consistent", async () => {
      const { sessionId, providerSessionId, conversation } = await queueSession("Expired lease reclaimed");
      await claimAgentSession(sessionId, "worker-A", 60_000);
      // Simulate worker-A crashing: its lease is now stale.
      await prisma.agentSession.update({ where: { id: sessionId }, data: { state: "RUNNING", leaseExpiresAt: new Date(Date.now() - 1_000) } });

      const reaped = await reapExpiredAgentSessions();
      expect(reaped).toBe(1);

      const session = await prisma.agentSession.findUniqueOrThrow({ where: { id: sessionId } });
      expect(session.state).toBe("FAILED");
      expect(session.workerId).toBeNull();
      expect(session.leaseExpiresAt).toBeNull();
      expect(session.error).toMatch(/lease expired/i);

      const providerSession = await prisma.providerSession.findUniqueOrThrow({ where: { id: providerSessionId } });
      expect(providerSession.status).toBe("FAILED");

      const assistant = await prisma.conversationMessage.findFirstOrThrow({ where: { conversationId: conversation.id, role: "ASSISTANT" } });
      expect(assistant.status).toBe("FAILED");
      expect(assistant.agentSessionId).toBe(sessionId);

      const reapEvent = await prisma.agentEvent.findFirst({ where: { sessionId, message: { contains: "lease expired" } } });
      expect(reapEvent).not.toBeNull();
    });

    it("treats a session that was never leased (older non-conversation flow) as eligible for reclaim", async () => {
      const project = await prisma.project.create({ data: { name: `worker-lease-legacy-${randomUUID()}`, repositoryPath: `/tmp/worker-lease-legacy-${randomUUID()}`, allowedCommands: [], permittedPaths: [], isVerification: true } });
      const task = await prisma.task.create({ data: { projectId: project.id, title: "Legacy task", userRequest: "x", objective: "x", relevantFiles: [], constraints: [], prohibitedChanges: [], assignedProvider: "codex-cli" } });
      const session = await prisma.agentSession.create({ data: { projectId: project.id, taskId: task.id, providerId: "codex-cli", state: "RUNNING" } }); // no workerId/leaseExpiresAt ever set

      const reaped = await reapExpiredAgentSessions();
      expect(reaped).toBeGreaterThanOrEqual(1);

      const reclaimed = await prisma.agentSession.findUniqueOrThrow({ where: { id: session.id } });
      expect(reclaimed.state).toBe("FAILED");
      await prisma.project.delete({ where: { id: project.id } }).catch(() => undefined);
    });

    it("is idempotent: running the sweep again after a reclaim makes no further changes", async () => {
      const { sessionId } = await queueSession("Idempotent reap");
      await claimAgentSession(sessionId, "worker-A", 60_000);
      await prisma.agentSession.update({ where: { id: sessionId }, data: { state: "RUNNING", leaseExpiresAt: new Date(Date.now() - 1_000) } });

      const first = await reapExpiredAgentSessions();
      expect(first).toBe(1);
      const second = await reapExpiredAgentSessions();
      expect(second).toBe(0);

      const assistants = await prisma.conversationMessage.findMany({ where: { agentSessionId: sessionId, role: "ASSISTANT" } });
      expect(assistants).toHaveLength(1);
    });

    it("is race-safe: concurrent reap sweeps on the same expired session only reclaim it once", async () => {
      const { sessionId } = await queueSession("Concurrent reap race");
      await claimAgentSession(sessionId, "worker-A", 60_000);
      await prisma.agentSession.update({ where: { id: sessionId }, data: { state: "RUNNING", leaseExpiresAt: new Date(Date.now() - 1_000) } });

      const [a, b, c] = await Promise.all([reapExpiredAgentSessions(), reapExpiredAgentSessions(), reapExpiredAgentSessions()]);
      expect(a + b + c).toBe(1);

      const assistants = await prisma.conversationMessage.findMany({ where: { agentSessionId: sessionId, role: "ASSISTANT" } });
      expect(assistants).toHaveLength(1);
    });
  });
});
