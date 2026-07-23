import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma, queueConversationMessage } from "@project-relay/database";
import { GET as getExecution } from "./conversations/[id]/executions/[executionId]/route.js";

const ORIGIN = "http://localhost:3300";

describe("conversation execution-state API authorization", () => {
  let projectId: string;
  let otherProjectId: string;

  beforeAll(async () => {
    const project = await prisma.project.create({
      data: {
        name: `conversation-worker-exec-test-${randomUUID()}`,
        repositoryPath: `/tmp/conversation-worker-exec-test-${randomUUID()}`,
        allowedCommands: [],
        permittedPaths: []
      }
    });
    projectId = project.id;
    const otherProject = await prisma.project.create({
      data: {
        name: `conversation-worker-exec-other-${randomUUID()}`,
        repositoryPath: `/tmp/conversation-worker-exec-other-${randomUUID()}`,
        allowedCommands: [],
        permittedPaths: []
      }
    });
    otherProjectId = otherProject.id;
  });

  afterAll(async () => {
    await prisma.project.delete({ where: { id: projectId } }).catch(() => undefined);
    await prisma.project.delete({ where: { id: otherProjectId } }).catch(() => undefined);
  });

  it("rejects execution-state access from a project that does not own the conversation", async () => {
    const conversation = await prisma.conversation.create({ data: { projectId, title: "Owned by first project" } });
    const queued = await queueConversationMessage({
      conversationId: conversation.id,
      projectId,
      content: "hello",
      mode: "ASK",
      selectedProviderId: "codex-cli",
      reason: "test",
      providerHealthSnapshot: {},
      previousAssistantMessage: null,
      idempotencyKey: randomUUID()
    });

    const request = new NextRequest(`${ORIGIN}/api/conversations/${conversation.id}/executions/${queued.agentSession.id}?projectId=${otherProjectId}`);
    const response = await getExecution(request, { params: Promise.resolve({ id: conversation.id, executionId: queued.agentSession.id }) });
    expect(response.status).toBe(404);
  });

  it("rejects execution-state access when projectId is missing", async () => {
    const conversation = await prisma.conversation.create({ data: { projectId, title: "Missing projectId" } });
    const queued = await queueConversationMessage({
      conversationId: conversation.id,
      projectId,
      content: "hello",
      mode: "ASK",
      selectedProviderId: "codex-cli",
      reason: "test",
      providerHealthSnapshot: {},
      previousAssistantMessage: null,
      idempotencyKey: randomUUID()
    });

    const request = new NextRequest(`${ORIGIN}/api/conversations/${conversation.id}/executions/${queued.agentSession.id}`);
    const response = await getExecution(request, { params: Promise.resolve({ id: conversation.id, executionId: queued.agentSession.id }) });
    expect(response.status).toBe(400);
  });

  it("returns execution state for an authorized request", async () => {
    const conversation = await prisma.conversation.create({ data: { projectId, title: "Authorized" } });
    const queued = await queueConversationMessage({
      conversationId: conversation.id,
      projectId,
      content: "hello",
      mode: "ASK",
      selectedProviderId: "codex-cli",
      reason: "test",
      providerHealthSnapshot: {},
      previousAssistantMessage: null,
      idempotencyKey: randomUUID()
    });

    const request = new NextRequest(`${ORIGIN}/api/conversations/${conversation.id}/executions/${queued.agentSession.id}?projectId=${projectId}`);
    const response = await getExecution(request, { params: Promise.resolve({ id: conversation.id, executionId: queued.agentSession.id }) });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("QUEUED");
    expect(body.selectedProvider).toBe("codex-cli");
  });
});
