import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { prisma } from "@project-relay/database";
import { terminateOwnedProcessTree } from "./owned-process.js";

export const DEFAULT_LEASE_MS = Number(process.env.PROJECT_RELAY_WORKER_LEASE_MS ?? 60_000);
const IN_PROGRESS_STATES = ["STARTING", "RUNNING"] as const;

/** A process-unique worker identity: readable for operators, unique enough to disambiguate concurrent workers. */
export function newWorkerId(): string {
  return `${hostname()}-${process.pid}-${randomUUID()}`;
}

/**
 * Compare-and-swap claim: only succeeds if the session is still QUEUED. Records this
 * worker's ownership and a lease that must be renewed (see startHeartbeat) or the
 * session becomes eligible for reclaim by a recovery sweep once it expires.
 */
export async function claimAgentSession(sessionId: string, workerId: string, leaseMs: number = DEFAULT_LEASE_MS): Promise<boolean> {
  const claimed = await prisma.agentSession.updateMany({
    where: { id: sessionId, state: "QUEUED" },
    data: { state: "STARTING", startedAt: new Date(), workerId, leaseExpiresAt: new Date(Date.now() + leaseMs) }
  });
  return claimed.count > 0;
}

/** Renews the lease periodically while this worker owns the session. Returns a stop function; always call it once the run finishes (success or failure). */
export function startHeartbeat(sessionId: string, workerId: string, leaseMs: number = DEFAULT_LEASE_MS): () => void {
  const intervalMs = Math.max(1_000, Math.floor(leaseMs / 3));
  const timer = setInterval(() => {
    void prisma.agentSession.updateMany({
      where: { id: sessionId, workerId, state: { in: [...IN_PROGRESS_STATES] } },
      data: { leaseExpiresAt: new Date(Date.now() + leaseMs) }
    }).catch(() => undefined);
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Clears ownership/lease fields; call alongside every terminal state transition so a finished session never looks claimed. */
export const releasedLeaseFields = { workerId: null, leaseExpiresAt: null } as const;

type ExpiredSession = {
  id: string;
  providerId: string;
  taskId: string;
  conversationId: string | null;
  providerSessionId: string | null;
  providerRootPid: number | null;
  providerProcessStartIdentity: string | null;
  userMessage: { mode: "ASK" | "IMPLEMENT" | "REVIEW" | "CONTINUE" | "VERIFY" } | null;
};

/**
 * Reclaims only sessions whose lease has genuinely expired (or was never leased at all,
 * covering the older non-conversation flow) - never a session a live worker is still
 * heartbeating. Safe to call concurrently from multiple worker processes and repeatedly:
 * each row is reclaimed via its own compare-and-swap, so a second caller racing on the
 * same row is a safe no-op, and an already-terminal row is simply skipped next time.
 */
export async function reapExpiredAgentSessions(now: Date = new Date()): Promise<number> {
  const candidates = await prisma.agentSession.findMany({
    where: { state: { in: [...IN_PROGRESS_STATES] }, OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }] },
    select: {
      id: true,
      providerId: true,
      taskId: true,
      conversationId: true,
      providerSessionId: true,
      providerRootPid: true,
      providerProcessStartIdentity: true,
      userMessage: { select: { mode: true } },
    }
  });

  let reaped = 0;
  for (const session of candidates as ExpiredSession[]) {
    const claimed = await prisma.agentSession.updateMany({
      where: { id: session.id, state: { in: [...IN_PROGRESS_STATES] }, OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }] },
      data: { state: "FAILED", endedAt: now, error: "Worker lease expired before the session completed.", ...releasedLeaseFields }
    });
    if (!claimed.count) continue; // another reap sweep already reclaimed this row
    reaped++;

    if (session.providerRootPid && session.providerProcessStartIdentity) {
      const terminationRequestedAt = new Date();
      await prisma.agentSession.updateMany({
        where: { id: session.id, state: "FAILED" },
        data: {
          providerTerminationRequestedAt: terminationRequestedAt,
          providerTerminationReason: "WORKER_RECOVERY",
        },
      });
      const result = await terminateOwnedProcessTree({
        rootPid: session.providerRootPid,
        expectedStartIdentity: session.providerProcessStartIdentity,
        agentSessionId: session.id,
        reason: "WORKER_RECOVERY",
      });
      await prisma.agentSession.updateMany({
        where: { id: session.id, state: "FAILED" },
        data: {
          providerTerminationCompletedAt: new Date(),
          providerTerminationResult: result,
        },
      });
    }

    await prisma.agentEvent.create({ data: { sessionId: session.id, type: "state", message: "Worker lease expired before the session completed." } }).catch(() => undefined);

    if (session.providerSessionId) {
      await prisma.providerSession.updateMany({
        where: { id: session.providerSessionId, status: { not: "FAILED" } },
        data: { status: "FAILED", endedAt: now }
      }).catch(() => undefined);
    }

    if (session.conversationId) {
      await prisma.conversationMessage.create({
        data: {
          conversationId: session.conversationId,
          role: "ASSISTANT",
          providerId: session.providerId,
          mode: session.userMessage?.mode ?? "ASK",
          content: "Worker lease expired before the session completed.",
          status: "FAILED",
          agentSessionId: session.id,
          ...(session.taskId ? { taskId: session.taskId } : {})
        }
      }).catch(() => undefined); // a concurrent reaper may have already created this row (unique per AgentSession)
    }
  }
  return reaped;
}
