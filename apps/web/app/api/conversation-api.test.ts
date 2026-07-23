import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@project-relay/database";
import { createAssistantMessage, createConversation, createUserMessage, getOrCreateProviderSession } from "@project-relay/database";
import { CSRF_COOKIE, CSRF_HEADER } from "../../lib/csrf";
import { LOCAL_SESSION_COOKIE } from "../../lib/local-auth-shared";
import { GET as listConversations, POST as createConversationRoute } from "./projects/[id]/conversations/route";
import { GET as getConversationDetail } from "./conversations/[id]/route";
import { GET as listConversationMessagesRoute } from "./conversations/[id]/messages/route";

const ORIGIN = "http://localhost:3300";
const CSRF_TOKEN = "test-csrf-token";
let sessionToken: string;

function jsonRequest(url: string, options: { method?: string; body?: unknown; withCsrf?: boolean; withSession?: boolean; origin?: string | null } = {}) {
  const headers = new Headers();
  headers.set("content-type", "application/json");
  const cookies: string[] = [];
  if (options.withCsrf !== false) {
    headers.set(CSRF_HEADER, CSRF_TOKEN);
    cookies.push(`${CSRF_COOKIE}=${CSRF_TOKEN}`);
  }
  if (options.withSession !== false) cookies.push(`${LOCAL_SESSION_COOKIE}=${sessionToken}`);
  if (cookies.length) headers.set("cookie", cookies.join("; "));
  if (options.origin !== null) headers.set("origin", options.origin ?? ORIGIN);
  return new NextRequest(url, {
    method: options.method ?? "GET",
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
}

describe("conversation CRUD API", () => {
  let projectId: string;
  let otherProjectId: string;

  beforeAll(async () => {
    const project = await prisma.project.create({
      data: {
        name: `conversation-api-test-${randomUUID()}`,
        repositoryPath: `/tmp/conversation-api-test-${randomUUID()}`,
        allowedCommands: [],
        permittedPaths: [],
      },
    });
    projectId = project.id;

    const otherProject = await prisma.project.create({
      data: {
        name: `conversation-api-test-other-${randomUUID()}`,
        repositoryPath: `/tmp/conversation-api-test-other-${randomUUID()}`,
        allowedCommands: [],
        permittedPaths: [],
      },
    });
    otherProjectId = otherProject.id;

    const session = await prisma.localSession.create({ data: { token: `test-session-${randomUUID()}` } });
    sessionToken = session.token;
  });

  afterAll(async () => {
    await prisma.project.delete({ where: { id: projectId } });
    await prisma.project.delete({ where: { id: otherProjectId } });
  });

  describe("POST /api/projects/:id/conversations", () => {
    it("creates a conversation for an authorized, same-origin, validated request", async () => {
      const request = jsonRequest(`${ORIGIN}/api/projects/${projectId}/conversations`, {
        method: "POST",
        body: { title: "First conversation" },
      });
      const response = await createConversationRoute(request, { params: Promise.resolve({ id: projectId }) });
      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.projectId).toBe(projectId);
      expect(body.title).toBe("First conversation");
      expect(body.status).toBe("ACTIVE");
    });

    it("rejects a same-origin request without a valid CSRF token as unauthorized", async () => {
      const request = jsonRequest(`${ORIGIN}/api/projects/${projectId}/conversations`, {
        method: "POST",
        body: { title: "Should fail" },
        withCsrf: false,
      });
      const response = await createConversationRoute(request, { params: Promise.resolve({ id: projectId }) });
      expect(response.status).toBe(401);
    });

    it("rejects a cross-origin request as a same-origin/CSRF violation", async () => {
      const request = jsonRequest(`${ORIGIN}/api/projects/${projectId}/conversations`, {
        method: "POST",
        body: { title: "Should fail" },
        origin: "https://evil.test",
      });
      const response = await createConversationRoute(request, { params: Promise.resolve({ id: projectId }) });
      expect(response.status).toBe(403);
    });

    it("rejects creation under a project the caller does not have access to", async () => {
      const request = jsonRequest(`${ORIGIN}/api/projects/unknown-project-id/conversations`, {
        method: "POST",
        body: { title: "Should fail" },
      });
      const response = await createConversationRoute(request, { params: Promise.resolve({ id: "unknown-project-id" }) });
      expect(response.status).toBe(404);
    });

    it("rejects an invalid body", async () => {
      const request = jsonRequest(`${ORIGIN}/api/projects/${projectId}/conversations`, {
        method: "POST",
        body: { title: "" },
      });
      const response = await createConversationRoute(request, { params: Promise.resolve({ id: projectId }) });
      expect(response.status).toBe(400);
    });

    it("rejects a request without a valid local session even with a valid CSRF token", async () => {
      const request = jsonRequest(`${ORIGIN}/api/projects/${projectId}/conversations`, {
        method: "POST",
        body: { title: "Should fail" },
        withSession: false,
      });
      const response = await createConversationRoute(request, { params: Promise.resolve({ id: projectId }) });
      expect(response.status).toBe(401);
    });
  });

  describe("GET /api/projects/:id/conversations", () => {
    it("lists conversations for the project ordered by updatedAt descending", async () => {
      const older = await createConversation(projectId, "Older");
      await new Promise(resolve => setTimeout(resolve, 5));
      const newer = await createConversation(projectId, "Newer");

      const request = jsonRequest(`${ORIGIN}/api/projects/${projectId}/conversations`);
      const response = await listConversations(request, { params: Promise.resolve({ id: projectId }) });
      expect(response.status).toBe(200);
      const body = await response.json() as Array<{ id: string }>;
      const olderIndex = body.findIndex(c => c.id === older.id);
      const newerIndex = body.findIndex(c => c.id === newer.id);
      expect(newerIndex).toBeLessThan(olderIndex);
    });
  });

  describe("GET /api/conversations/:id", () => {
    it("returns conversation details with ordered messages and separate provider sessions", async () => {
      const conversation = await createConversation(projectId, "Detail view");
      const first = await createUserMessage(conversation.id, "hello", "ASK");
      await new Promise(resolve => setTimeout(resolve, 5));
      const second = await createAssistantMessage({
        conversationId: conversation.id,
        providerId: "codex-cli",
        providerSessionId: "unused",
        mode: "ASK",
        content: "hi",
      });
      const codexSession = await getOrCreateProviderSession(conversation.id, "codex-cli");
      const claudeSession = await getOrCreateProviderSession(conversation.id, "claude-cli");

      const request = jsonRequest(`${ORIGIN}/api/conversations/${conversation.id}?projectId=${projectId}`);
      const response = await getConversationDetail(request, { params: Promise.resolve({ id: conversation.id }) });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.messages.map((m: { id: string }) => m.id)).toEqual([first.id, second.id]);
      const providerIds = body.providerSessions.map((s: { id: string; providerId: string }) => s.providerId);
      expect(providerIds).toContain("codex-cli");
      expect(providerIds).toContain("claude-cli");
      const sessionIds = new Set(body.providerSessions.map((s: { id: string }) => s.id));
      expect(sessionIds.has(codexSession.id)).toBe(true);
      expect(sessionIds.has(claudeSession.id)).toBe(true);
      expect(sessionIds.size).toBe(body.providerSessions.length);
    });

    it("rejects a conversation that belongs to a different project", async () => {
      const conversation = await createConversation(projectId, "Owned by first project");
      const request = jsonRequest(`${ORIGIN}/api/conversations/${conversation.id}?projectId=${otherProjectId}`);
      const response = await getConversationDetail(request, { params: Promise.resolve({ id: conversation.id }) });
      expect(response.status).toBe(404);
    });

    it("returns not found for an unknown conversation", async () => {
      const request = jsonRequest(`${ORIGIN}/api/conversations/does-not-exist?projectId=${projectId}`);
      const response = await getConversationDetail(request, { params: Promise.resolve({ id: "does-not-exist" }) });
      expect(response.status).toBe(404);
    });
  });

  describe("GET /api/conversations/:id/messages", () => {
    it("returns persisted messages in deterministic chronological order", async () => {
      const conversation = await createConversation(projectId, "Message ordering");
      const first = await createUserMessage(conversation.id, "first", "ASK");
      await new Promise(resolve => setTimeout(resolve, 5));
      const second = await createUserMessage(conversation.id, "second", "IMPLEMENT");

      const request = jsonRequest(`${ORIGIN}/api/conversations/${conversation.id}/messages?projectId=${projectId}`);
      const response = await listConversationMessagesRoute(request, { params: Promise.resolve({ id: conversation.id }) });
      expect(response.status).toBe(200);
      const body = await response.json() as Array<{ id: string }>;
      expect(body.map(m => m.id)).toEqual([first.id, second.id]);
    });
  });
});
