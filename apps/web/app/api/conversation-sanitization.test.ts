import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@project-relay/database";
import { CSRF_COOKIE, CSRF_HEADER } from "../../lib/csrf";
import { LOCAL_SESSION_COOKIE } from "../../lib/local-auth-shared";
import { GET as getConversation } from "./conversations/[id]/route.js";
import { GET as getExecution } from "./conversations/[id]/executions/[executionId]/route.js";
import { GET as getMessages, POST as postMessage } from "./conversations/[id]/messages/route.js";

const ORIGIN = "http://localhost:3300";
const CSRF_TOKEN = "test-csrf-token";

function request(url: string, options: { method?: string; body?: unknown; sessionToken?: string } = {}) {
  const headers = new Headers({ "content-type": "application/json", origin: ORIGIN });
  const cookies = [`${CSRF_COOKIE}=${CSRF_TOKEN}`];
  if (options.sessionToken) {
    headers.set(CSRF_HEADER, CSRF_TOKEN);
    cookies.push(`${LOCAL_SESSION_COOKIE}=${options.sessionToken}`);
  }
  headers.set("cookie", cookies.join("; "));
  return new NextRequest(url, { method: options.method ?? "GET", headers, ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}) });
}

describe("conversation API response sanitization", () => {
  let projectId: string;
  let sessionToken: string;

  beforeAll(async () => {
    const project = await prisma.project.create({
      data: { name: `sanitization-test-${randomUUID()}`, repositoryPath: `/tmp/sanitization-test-${randomUUID()}`, allowedCommands: [], permittedPaths: [], isVerification: true }
    });
    projectId = project.id;
    const session = await prisma.localSession.create({ data: { token: `test-session-${randomUUID()}` } });
    sessionToken = session.token;
  });

  afterAll(async () => {
    await prisma.project.delete({ where: { id: projectId } }).catch(() => undefined);
  });

  beforeEach(async () => {
    const data = { installed: true, authentication: "AUTHENTICATED" as const, available: true };
    await prisma.providerHealth.upsert({ where: { providerId: "codex-cli" }, create: { providerId: "codex-cli", ...data }, update: data });
    await prisma.providerHealth.upsert({ where: { providerId: "claude-cli" }, create: { providerId: "claude-cli", ...data }, update: data });
  });

  async function newConversationWithRealExternalId(title: string) {
    const conversation = await prisma.conversation.create({ data: { projectId, title } });
    const providerSession = await prisma.providerSession.create({
      data: { conversationId: conversation.id, providerId: "codex-cli", status: "RUNNING", startedAt: new Date(), externalSessionId: "codex-real-external-thread-id-should-never-leak" }
    });
    const task = await prisma.task.create({ data: { projectId, title: "t", userRequest: "u", objective: "o", relevantFiles: [], constraints: [], prohibitedChanges: [], assignedProvider: "codex-cli" } });
    const userMessage = await prisma.conversationMessage.create({ data: { conversationId: conversation.id, role: "USER", mode: "ASK", content: "hello", status: "COMPLETED" } });
    const agentSession = await prisma.agentSession.create({
      data: { projectId, taskId: task.id, providerId: "codex-cli", state: "SUCCEEDED", conversationId: conversation.id, providerSessionId: providerSession.id, userMessageId: userMessage.id, externalId: "codex-real-external-thread-id-should-never-leak" }
    });
    return { conversation, providerSession, agentSession };
  }

  it("GET /api/conversations/:id never exposes ProviderSession.externalSessionId", async () => {
    const { conversation } = await newConversationWithRealExternalId("Detail leak check");
    const response = await getConversation(request(`${ORIGIN}/api/conversations/${conversation.id}?projectId=${projectId}`), { params: Promise.resolve({ id: conversation.id }) });
    expect(response.status).toBe(200);
    const raw = await response.text();
    expect(raw).not.toContain("externalSessionId");
    expect(raw).not.toContain("codex-real-external-thread-id-should-never-leak");
  });

  it("GET /api/conversations/:id/executions/:executionId never exposes ProviderSession.externalSessionId", async () => {
    const { conversation, agentSession } = await newConversationWithRealExternalId("Execution leak check");
    const response = await getExecution(
      request(`${ORIGIN}/api/conversations/${conversation.id}/executions/${agentSession.id}?projectId=${projectId}`),
      { params: Promise.resolve({ id: conversation.id, executionId: agentSession.id }) }
    );
    expect(response.status).toBe(200);
    const raw = await response.text();
    expect(raw).not.toContain("externalSessionId");
    expect(raw).not.toContain("codex-real-external-thread-id-should-never-leak");
  });

  it("GET /api/conversations/:id/messages never exposes ProviderSession.externalSessionId", async () => {
    const { conversation } = await newConversationWithRealExternalId("Messages leak check");
    const response = await getMessages(request(`${ORIGIN}/api/conversations/${conversation.id}/messages?projectId=${projectId}`), { params: Promise.resolve({ id: conversation.id }) });
    expect(response.status).toBe(200);
    const raw = await response.text();
    expect(raw).not.toContain("externalSessionId");
  });

  it("POST /api/conversations/:id/messages never exposes ProviderSession.externalSessionId, even when resuming an existing session", async () => {
    const { conversation } = await newConversationWithRealExternalId("Post leak check");
    const response = await postMessage(
      request(`${ORIGIN}/api/conversations/${conversation.id}/messages`, { method: "POST", sessionToken, body: { content: "continue", provider: "codex-cli", mode: "ASK", idempotencyKey: randomUUID() } }),
      { params: Promise.resolve({ id: conversation.id }) }
    );
    expect(response.status).toBe(202);
    const raw = await response.text();
    expect(raw).not.toContain("externalSessionId");
    expect(raw).not.toContain("codex-real-external-thread-id-should-never-leak");
  });

  describe("stable public error codes", () => {
    it("returns a stable NOT_FOUND code for an unknown conversation", async () => {
      const response = await getConversation(request(`${ORIGIN}/api/conversations/does-not-exist?projectId=${projectId}`), { params: Promise.resolve({ id: "does-not-exist" }) });
      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.code).toBe("NOT_FOUND");
    });

    it("returns a stable VALIDATION_ERROR code when projectId is missing", async () => {
      const response = await getConversation(request(`${ORIGIN}/api/conversations/anything`), { params: Promise.resolve({ id: "anything" }) });
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.code).toBe("VALIDATION_ERROR");
    });

    it("returns a stable CONFLICT code when no provider is capable/available", async () => {
      await prisma.providerHealth.update({ where: { providerId: "codex-cli" }, data: { available: false } });
      await prisma.providerHealth.update({ where: { providerId: "claude-cli" }, data: { available: false } });
      const conversation = await prisma.conversation.create({ data: { projectId, title: "No provider available" } });
      const response = await postMessage(
        request(`${ORIGIN}/api/conversations/${conversation.id}/messages`, { method: "POST", sessionToken, body: { content: "hello", provider: "auto", mode: "ASK", idempotencyKey: randomUUID() } }),
        { params: Promise.resolve({ id: conversation.id }) }
      );
      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.code).toBe("CONFLICT");
    });

    it("returns a stable UNAUTHENTICATED code without a local session", async () => {
      const conversation = await prisma.conversation.create({ data: { projectId, title: "No session" } });
      const response = await postMessage(
        request(`${ORIGIN}/api/conversations/${conversation.id}/messages`, { method: "POST", body: { content: "hello", provider: "codex-cli", mode: "ASK" } }),
        { params: Promise.resolve({ id: conversation.id }) }
      );
      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.code).toBe("UNAUTHENTICATED");
    });
  });
});
