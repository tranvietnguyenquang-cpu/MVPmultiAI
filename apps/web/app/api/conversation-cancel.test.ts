import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma, queueConversationMessage } from "@project-relay/database";
import { CSRF_COOKIE, CSRF_HEADER } from "../../lib/csrf";
import { captureOwnedProcess } from "../../../worker/src/owned-process.js";
import { terminateRecordedProviderProcess } from "../../../worker/src/conversation-worker.js";
import { claimAgentSession } from "../../../worker/src/worker-lease.js";
import { POST as postCancel } from "./conversations/[id]/executions/[executionId]/cancel/route.js";

const ORIGIN = "http://localhost:3300";
const CSRF_TOKEN = "test-cancel-csrf-token";
const execFileAsync = promisify(execFile);
// apps/web is CommonJS for tsc's project-level type-checking purposes (no "type":"module"
// in its package.json), so import.meta.url is not usable here - __dirname is the
// CommonJS-safe equivalent, and Vitest's own ESM runtime shims it for compatibility.
const fixture = path.join(__dirname, "..", "..", "..", "worker", "src", "owned-process.fixture.cjs");

function cancelRequest(conversationId: string, executionId: string, projectId: string) {
  const headers = new Headers();
  headers.set(CSRF_HEADER, CSRF_TOKEN);
  headers.set("cookie", `${CSRF_COOKIE}=${CSRF_TOKEN}`);
  headers.set("origin", ORIGIN);
  const request = new NextRequest(`${ORIGIN}/api/conversations/${conversationId}/executions/${executionId}/cancel?projectId=${projectId}`, {
    method: "POST",
    headers,
  });
  return postCancel(request, { params: Promise.resolve({ id: conversationId, executionId }) });
}

type TreePids = { rootPid: number; childPid: number; grandchildPid: number };

function spawnFixture(role: "root" | "sibling"): ChildProcess {
  return spawn(process.execPath, [fixture, role], {
    stdio: role === "root" ? ["ignore", "pipe", "ignore"] : "ignore",
    windowsHide: true,
  });
}

async function readTree(root: ChildProcess): Promise<TreePids> {
  const [chunk] = await once(root.stdout!, "data");
  return JSON.parse(Buffer.from(chunk).toString("utf8")) as TreePids;
}

async function processExists(pid: number): Promise<boolean> {
  try {
    await execFileAsync("powershell.exe", ["-NoProfile", "-Command", `Get-Process -Id ${pid} -ErrorAction Stop | Out-Null`], { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (!(await processExists(pid))) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Process ${pid} did not exit after bounded termination.`);
}

describe("conversation execution cancellation API", () => {
  let projectId: string;

  beforeAll(async () => {
    const project = await prisma.project.create({
      data: {
        name: `conversation-cancel-test-${randomUUID()}`,
        repositoryPath: `/tmp/conversation-cancel-test-${randomUUID()}`,
        allowedCommands: [],
        permittedPaths: [],
        isVerification: true,
      },
    });
    projectId = project.id;
  });

  afterAll(async () => {
    await prisma.project.delete({ where: { id: projectId } }).catch(() => undefined);
  });

  it("invalidates a QUEUED execution before any provider process can be spawned, and stays idempotent on repeat", async () => {
    const conversation = await prisma.conversation.create({ data: { projectId, title: "Queued cancellation" } });
    const queued = await queueConversationMessage({
      conversationId: conversation.id,
      projectId,
      content: "cancel before spawn",
      mode: "ASK",
      selectedProviderId: "codex-cli",
      reason: "test",
      providerHealthSnapshot: {},
      previousAssistantMessage: null,
      idempotencyKey: randomUUID(),
    });
    const executionId = queued.agentSession.id;

    const first = await cancelRequest(conversation.id, executionId, projectId);
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody).toMatchObject({ cancelled: true, state: "CANCELLED", termination: "not-required" });

    const cancelledSession = await prisma.agentSession.findUniqueOrThrow({ where: { id: executionId } });
    expect(cancelledSession.state).toBe("CANCELLED");
    expect(cancelledSession.failureCode).toBe("PROVIDER_CANCELLED");

    // The outbox job backing this execution must be invalidated so a worker that later
    // polls the outbox can never publish it, and a worker that already has it queued
    // must refuse to claim it (see claimAgentSession below): no provider is ever spawned.
    const remainingOutbox = await prisma.outboxEvent.findMany({ where: { jobId: executionId, status: { in: ["PENDING", "FAILED"] } } });
    expect(remainingOutbox).toHaveLength(0);

    const claimed = await claimAgentSession(executionId, "would-be-spawner", 60_000);
    expect(claimed).toBe(false);
    const stillCancelled = await prisma.agentSession.findUniqueOrThrow({ where: { id: executionId } });
    expect(stillCancelled.state).toBe("CANCELLED");
    expect(stillCancelled.workerId).toBeNull();

    const second = await cancelRequest(conversation.id, executionId, projectId);
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody).toMatchObject({ cancelled: true, state: "CANCELLED" });
  });

  it("marks a RUNNING execution CANCELLED without terminating it directly, then the worker's recorded termination kills the real owned tree and spares an unrelated sibling", async () => {
    const conversation = await prisma.conversation.create({ data: { projectId, title: "Running cancellation" } });
    const queued = await queueConversationMessage({
      conversationId: conversation.id,
      projectId,
      content: "cancel while running",
      mode: "ASK",
      selectedProviderId: "codex-cli",
      reason: "test",
      providerHealthSnapshot: {},
      previousAssistantMessage: null,
      idempotencyKey: randomUUID(),
    });
    const executionId = queued.agentSession.id;

    const root = spawnFixture("root");
    const sibling = spawnFixture("sibling");
    let rootPids: TreePids | undefined;
    let owned: Awaited<ReturnType<typeof captureOwnedProcess>> | undefined;

    try {
      rootPids = await readTree(root);
      owned = await captureOwnedProcess({
        rootPid: rootPids.rootPid,
        agentSessionId: executionId,
        providerId: "codex-cli",
        workerId: "fixture-worker",
      });
      await prisma.agentSession.update({
        where: { id: executionId },
        data: {
          state: "RUNNING",
          workerId: "fixture-worker",
          providerRootPid: owned.rootPid,
          providerProcessStartedAt: new Date(owned.startedAt),
          providerProcessStartIdentity: owned.startedAt,
        },
      });

      const response = await cancelRequest(conversation.id, executionId, projectId);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({ cancelled: true, state: "CANCELLED", termination: "requested" });

      // The HTTP route only ever records the cancellation request; it must never hold
      // a PID or attempt termination itself. The real process is still alive at this point.
      const afterRoute = await prisma.agentSession.findUniqueOrThrow({ where: { id: executionId } });
      expect(afterRoute.state).toBe("CANCELLED");
      expect(afterRoute.providerTerminationReason).toBe("CANCELLED");
      expect(afterRoute.providerTerminationCompletedAt).toBeNull();
      expect(await processExists(rootPids.rootPid)).toBe(true);

      // This mirrors what the owning worker's cancellation-observer does once it sees the
      // CANCELLED state: load the recorded PID/start-identity and terminate only that tree.
      const result = await terminateRecordedProviderProcess({
        agentSessionId: executionId,
        reason: "CANCELLED",
        workerId: "fixture-worker",
      });
      expect(result).toBe("TERMINATED");
      await Promise.all([waitForExit(rootPids.rootPid), waitForExit(rootPids.childPid), waitForExit(rootPids.grandchildPid)]);
      expect(await processExists(sibling.pid!)).toBe(true);

      const final = await prisma.agentSession.findUniqueOrThrow({ where: { id: executionId } });
      expect(final.state).toBe("CANCELLED");
      expect(final.providerTerminationResult).toBe("TERMINATED");
      expect(final.providerTerminationCompletedAt).toBeTruthy();
    } finally {
      if (owned && rootPids && (await processExists(rootPids.rootPid))) {
        await execFileAsync("taskkill", ["/pid", String(rootPids.rootPid), "/t", "/f"], { windowsHide: true }).catch(() => undefined);
      }
      sibling.kill();
      if (sibling.pid) await waitForExit(sibling.pid).catch(() => undefined);
    }
  }, 20_000);

  it("refuses to report an execution outside the requesting project", async () => {
    const conversation = await prisma.conversation.create({ data: { projectId, title: "Cross-project cancel" } });
    const queued = await queueConversationMessage({
      conversationId: conversation.id,
      projectId,
      content: "hello",
      mode: "ASK",
      selectedProviderId: "codex-cli",
      reason: "test",
      providerHealthSnapshot: {},
      previousAssistantMessage: null,
      idempotencyKey: randomUUID(),
    });

    const otherProject = await prisma.project.create({
      data: {
        name: `conversation-cancel-other-${randomUUID()}`,
        repositoryPath: `/tmp/conversation-cancel-other-${randomUUID()}`,
        allowedCommands: [],
        permittedPaths: [],
        isVerification: true,
      },
    });
    try {
      const response = await cancelRequest(conversation.id, queued.agentSession.id, otherProject.id);
      expect(response.status).toBe(404);
      const session = await prisma.agentSession.findUniqueOrThrow({ where: { id: queued.agentSession.id } });
      expect(session.state).toBe("QUEUED");
    } finally {
      await prisma.project.delete({ where: { id: otherProject.id } }).catch(() => undefined);
    }
  });
});
