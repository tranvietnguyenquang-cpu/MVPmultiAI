import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, type ProviderAuthenticationStatus } from "@project-relay/database";
import { createAssistantMessage, createConversation, handoffChecksum } from "@project-relay/database";
import { CSRF_COOKIE, CSRF_HEADER } from "../../lib/csrf";

const { queueAddMock } = vi.hoisted(() => ({ queueAddMock: vi.fn(async () => undefined) }));
vi.mock("../../lib/redis", () => ({
  getConversationMessageQueue: () => ({ add: queueAddMock }),
}));

import { POST as postMessage } from "./conversations/[id]/messages/route.js";

const ORIGIN = "http://localhost:3300";
const CSRF_TOKEN = "test-csrf-token";

function jsonRequest(url: string, options: { method?: string; body?: unknown; withCsrf?: boolean; origin?: string | null } = {}) {
  const headers = new Headers();
  headers.set("content-type", "application/json");
  if (options.withCsrf !== false) {
    headers.set(CSRF_HEADER, CSRF_TOKEN);
    headers.set("cookie", `${CSRF_COOKIE}=${CSRF_TOKEN}`);
  }
  if (options.origin !== null) headers.set("origin", options.origin ?? ORIGIN);
  return new NextRequest(url, {
    method: options.method ?? "POST",
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
}

async function setProviderHealth(providerId: "codex-cli" | "claude-cli", overrides: Partial<{ installed: boolean; authentication: ProviderAuthenticationStatus; available: boolean }>) {
  const data = { installed: true, authentication: "AUTHENTICATED" as ProviderAuthenticationStatus, available: true, ...overrides };
  await prisma.providerHealth.upsert({
    where: { providerId },
    create: { providerId, ...data },
    update: data,
  });
}

async function healthyBoth() {
  await setProviderHealth("codex-cli", {});
  await setProviderHealth("claude-cli", {});
}

function postJson(conversationId: string, body: unknown, options: { withCsrf?: boolean; origin?: string | null } = {}) {
  const request = jsonRequest(`${ORIGIN}/api/conversations/${conversationId}/messages`, { method: "POST", body, ...options });
  return postMessage(request, { params: Promise.resolve({ id: conversationId }) });
}

describe("conversation message orchestration API", () => {
  let projectId: string;

  beforeAll(async () => {
    const project = await prisma.project.create({
      data: {
        name: `conversation-message-test-${randomUUID()}`,
        repositoryPath: `/tmp/conversation-message-test-${randomUUID()}`,
        allowedCommands: [],
        permittedPaths: [],
      },
    });
    projectId = project.id;
  });

  afterAll(async () => {
    await prisma.project.delete({ where: { id: projectId } }).catch(() => undefined);
  });

  beforeEach(async () => {
    queueAddMock.mockReset();
    queueAddMock.mockResolvedValue(undefined);
    await healthyBoth();
  });

  afterEach(async () => {
    vi.clearAllMocks();
  });

  describe("explicit routing", () => {
    it("routes to Codex when explicitly requested and healthy", async () => {
      const conversation = await createConversation(projectId, "Explicit codex");
      const response = await postJson(conversation.id, { content: "hello", provider: "codex-cli", mode: "ASK" });
      expect(response.status).toBe(202);
      const body = await response.json();
      expect(body.selectedProvider).toBe("codex-cli");
      expect(body.routingDecision.selectedProviderId).toBe("codex-cli");
      expect(body.routingDecision.requestedProviderId).toBe("codex-cli");
    });

    it("routes to Claude when explicitly requested and healthy", async () => {
      const conversation = await createConversation(projectId, "Explicit claude");
      const response = await postJson(conversation.id, { content: "hello", provider: "claude-cli", mode: "ASK" });
      expect(response.status).toBe(202);
      const body = await response.json();
      expect(body.selectedProvider).toBe("claude-cli");
    });

    it("rejects an explicit Codex request when Codex is unavailable", async () => {
      await setProviderHealth("codex-cli", { available: false });
      const conversation = await createConversation(projectId, "Codex unavailable");
      const response = await postJson(conversation.id, { content: "hello", provider: "codex-cli", mode: "ASK" });
      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.error).toMatch(/codex-cli/);
    });

    it("rejects an explicit Claude request when Claude is unavailable", async () => {
      await setProviderHealth("claude-cli", { authentication: "NOT_AUTHENTICATED" });
      const conversation = await createConversation(projectId, "Claude unavailable");
      const response = await postJson(conversation.id, { content: "hello", provider: "claude-cli", mode: "ASK" });
      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.error).toMatch(/claude-cli/);
    });
  });

  describe("auto routing", () => {
    it("prefers the current healthy provider", async () => {
      const conversation = await createConversation(projectId, "Auto prefers current");
      await createAssistantMessage({ conversationId: conversation.id, providerId: "claude-cli", providerSessionId: "unused", mode: "ASK", content: "prior reply" });
      const response = await postJson(conversation.id, { content: "hello", provider: "auto", mode: "ASK" });
      expect(response.status).toBe(202);
      const body = await response.json();
      expect(body.selectedProvider).toBe("claude-cli");
      expect(body.routingDecision.requestedProviderId).toBeNull();
    });

    it("falls back to the other healthy provider when the current one is unhealthy", async () => {
      const conversation = await createConversation(projectId, "Auto falls back");
      await createAssistantMessage({ conversationId: conversation.id, providerId: "codex-cli", providerSessionId: "unused", mode: "ASK", content: "prior reply" });
      await setProviderHealth("codex-cli", { available: false });
      const response = await postJson(conversation.id, { content: "hello", provider: "auto", mode: "ASK" });
      expect(response.status).toBe(202);
      const body = await response.json();
      expect(body.selectedProvider).toBe("claude-cli");
    });

    it("refuses when neither provider is usable and persists nothing", async () => {
      await setProviderHealth("codex-cli", { available: false });
      await setProviderHealth("claude-cli", { authentication: "RATE_LIMITED" });
      const conversation = await createConversation(projectId, "Auto refuses");
      const response = await postJson(conversation.id, { content: "hello", provider: "auto", mode: "ASK" });
      expect(response.status).toBe(409);
      const messages = await prisma.conversationMessage.findMany({ where: { conversationId: conversation.id } });
      expect(messages).toHaveLength(0);
      const decisions = await prisma.routingDecision.findMany({ where: { conversationId: conversation.id } });
      expect(decisions).toHaveLength(0);
    });
  });

  describe("handoff capsules", () => {
    it("does not create a handoff for the first conversation message", async () => {
      const conversation = await createConversation(projectId, "First message");
      const response = await postJson(conversation.id, { content: "hello", provider: "codex-cli", mode: "ASK" });
      expect(response.status).toBe(202);
      const body = await response.json();
      expect(body.handoffCapsule).toBeNull();
      const capsules = await prisma.handoffCapsule.findMany({ where: { conversationId: conversation.id } });
      expect(capsules).toHaveLength(0);
    });

    it("creates exactly one handoff capsule when switching from Codex to Claude", async () => {
      const conversation = await createConversation(projectId, "Codex to Claude");
      await createAssistantMessage({ conversationId: conversation.id, providerId: "codex-cli", providerSessionId: "unused", mode: "ASK", content: "codex reply" });
      const response = await postJson(conversation.id, { content: "switch please", provider: "claude-cli", mode: "ASK" });
      expect(response.status).toBe(202);
      const body = await response.json();
      expect(body.handoffCapsule).not.toBeNull();
      expect(body.handoffCapsule.fromProviderId).toBe("codex-cli");
      expect(body.handoffCapsule.toProviderId).toBe("claude-cli");
      expect(body.handoffCapsule.version).toBe(1);
      const capsules = await prisma.handoffCapsule.findMany({ where: { conversationId: conversation.id } });
      expect(capsules).toHaveLength(1);
    });

    it("creates exactly one handoff capsule when switching from Claude to Codex", async () => {
      const conversation = await createConversation(projectId, "Claude to Codex");
      await createAssistantMessage({ conversationId: conversation.id, providerId: "claude-cli", providerSessionId: "unused", mode: "ASK", content: "claude reply" });
      const response = await postJson(conversation.id, { content: "switch please", provider: "codex-cli", mode: "ASK" });
      expect(response.status).toBe(202);
      const body = await response.json();
      expect(body.handoffCapsule).not.toBeNull();
      expect(body.handoffCapsule.fromProviderId).toBe("claude-cli");
      expect(body.handoffCapsule.toProviderId).toBe("codex-cli");
      const capsules = await prisma.handoffCapsule.findMany({ where: { conversationId: conversation.id } });
      expect(capsules).toHaveLength(1);
    });

    it("does not create another handoff when continuing with the same provider", async () => {
      const conversation = await createConversation(projectId, "Same provider continuation");
      await createAssistantMessage({ conversationId: conversation.id, providerId: "codex-cli", providerSessionId: "unused", mode: "ASK", content: "codex reply" });
      const response = await postJson(conversation.id, { content: "keep going", provider: "codex-cli", mode: "ASK" });
      expect(response.status).toBe(202);
      const body = await response.json();
      expect(body.handoffCapsule).toBeNull();
      const capsules = await prisma.handoffCapsule.findMany({ where: { conversationId: conversation.id } });
      expect(capsules).toHaveLength(0);
    });

    it("computes a deterministic checksum independent of key order", () => {
      expect(handoffChecksum({ b: 2, a: { z: 1, y: 2 } })).toBe(handoffChecksum({ a: { y: 2, z: 1 }, b: 2 }));
    });

    it("bounds the handoff payload even with maximal message content", async () => {
      const conversation = await createConversation(projectId, "Bounded handoff");
      await createAssistantMessage({ conversationId: conversation.id, providerId: "codex-cli", providerSessionId: "unused", mode: "ASK", content: "codex reply" });
      const response = await postJson(conversation.id, { content: "x".repeat(20_000), provider: "claude-cli", mode: "ASK" });
      expect(response.status).toBe(202);
      const body = await response.json();
      const capsule = await prisma.handoffCapsule.findUniqueOrThrow({ where: { id: body.handoffCapsule.id } });
      expect((capsule.objective as string).length).toBeLessThanOrEqual(2_000);
      expect(Buffer.byteLength(JSON.stringify(capsule))).toBeLessThan(64_000);
    });

    it("excludes unrelated old messages from the handoff source range", async () => {
      const conversation = await createConversation(projectId, "Excludes old history");
      const oldAssistant = await createAssistantMessage({ conversationId: conversation.id, providerId: "codex-cli", providerSessionId: "unused", mode: "ASK", content: "old codex reply" });
      await new Promise(resolve => setTimeout(resolve, 5));
      await createAssistantMessage({ conversationId: conversation.id, providerId: "codex-cli", providerSessionId: "unused", mode: "ASK", content: "recent codex reply" });
      const recentAssistant = await prisma.conversationMessage.findFirst({ where: { conversationId: conversation.id, role: "ASSISTANT" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });

      const response = await postJson(conversation.id, { content: "switch to claude", provider: "claude-cli", mode: "ASK" });
      expect(response.status).toBe(202);
      const body = await response.json();
      const capsule = await prisma.handoffCapsule.findUniqueOrThrow({ where: { id: body.handoffCapsule.id } });
      const sourceMessageRange = capsule.sourceMessageRange as { fromMessageId: string; toMessageId: string };
      expect(sourceMessageRange.fromMessageId).toBe(recentAssistant?.id);
      expect(sourceMessageRange.fromMessageId).not.toBe(oldAssistant.id);
    });
  });

  describe("provider sessions", () => {
    it("keeps Codex and Claude provider sessions separate", async () => {
      const conversation = await createConversation(projectId, "Separate sessions");
      const codexResponse = await postJson(conversation.id, { content: "hello codex", provider: "codex-cli", mode: "ASK" });
      const codexBody = await codexResponse.json();
      const claudeResponse = await postJson(conversation.id, { content: "hello claude", provider: "claude-cli", mode: "ASK" });
      const claudeBody = await claudeResponse.json();
      expect(codexBody.providerSession.id).not.toBe(claudeBody.providerSession.id);
      expect(codexBody.providerSession.providerId).toBe("codex-cli");
      expect(claudeBody.providerSession.providerId).toBe("claude-cli");
    });
  });

  describe("input validation", () => {
    it("rejects an invalid provider", async () => {
      const conversation = await createConversation(projectId, "Invalid provider");
      const response = await postJson(conversation.id, { content: "hello", provider: "gpt-4", mode: "ASK" });
      expect(response.status).toBe(400);
    });

    it("rejects an invalid mode", async () => {
      const conversation = await createConversation(projectId, "Invalid mode");
      const response = await postJson(conversation.id, { content: "hello", provider: "codex-cli", mode: "CHAT" });
      expect(response.status).toBe(400);
    });

    it("rejects empty content", async () => {
      const conversation = await createConversation(projectId, "Empty content");
      const response = await postJson(conversation.id, { content: "", provider: "codex-cli", mode: "ASK" });
      expect(response.status).toBe(400);
    });

    it("rejects an invalid taskId", async () => {
      const conversation = await createConversation(projectId, "Invalid task");
      const response = await postJson(conversation.id, { content: "hello", provider: "codex-cli", mode: "ASK", taskId: "does-not-exist" });
      expect(response.status).toBe(400);
    });
  });

  describe("authorization and CSRF", () => {
    it("rejects access to a conversation whose project is no longer authorized", async () => {
      const archivedProject = await prisma.project.create({
        data: {
          name: `archived-project-${randomUUID()}`,
          repositoryPath: `/tmp/archived-project-${randomUUID()}`,
          allowedCommands: [],
          permittedPaths: [],
          archivedAt: new Date(),
        },
      });
      const conversation = await createConversation(archivedProject.id, "Archived project conversation");
      const response = await postJson(conversation.id, { content: "hello", provider: "codex-cli", mode: "ASK" });
      expect(response.status).toBe(404);
      await prisma.project.delete({ where: { id: archivedProject.id } });
    });

    it("rejects a same-origin request without a valid CSRF token", async () => {
      const conversation = await createConversation(projectId, "Missing csrf");
      const response = await postJson(conversation.id, { content: "hello", provider: "codex-cli", mode: "ASK" }, { withCsrf: false });
      expect(response.status).toBe(401);
    });

    it("rejects a cross-origin request", async () => {
      const conversation = await createConversation(projectId, "Cross origin");
      const response = await postJson(conversation.id, { content: "hello", provider: "codex-cli", mode: "ASK" }, { origin: "https://evil.test" });
      expect(response.status).toBe(403);
    });
  });

  describe("transactional rollback", () => {
    it("rolls back the entire orchestration when queue creation fails", async () => {
      queueAddMock.mockRejectedValueOnce(new Error("forced queue failure"));
      const conversation = await createConversation(projectId, "Rollback test");

      const response = await postJson(conversation.id, { content: "should roll back", provider: "codex-cli", mode: "ASK" });
      expect(response.status).toBe(500);

      const messages = await prisma.conversationMessage.findMany({ where: { conversationId: conversation.id } });
      expect(messages).toHaveLength(0);
      const decisions = await prisma.routingDecision.findMany({ where: { conversationId: conversation.id } });
      expect(decisions).toHaveLength(0);
      const sessions = await prisma.providerSession.findMany({ where: { conversationId: conversation.id } });
      expect(sessions).toHaveLength(0);
      const capsules = await prisma.handoffCapsule.findMany({ where: { conversationId: conversation.id } });
      expect(capsules).toHaveLength(0);
    });
  });
});
