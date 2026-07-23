import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@project-relay/database";
import { CSRF_COOKIE, CSRF_HEADER } from "../../lib/csrf";
import { LOCAL_SESSION_COOKIE } from "../../lib/local-auth-shared";
import { POST as postMessage } from "./conversations/[id]/messages/route.js";

const ORIGIN = "http://localhost:3300";
const CSRF_TOKEN = "test-csrf-token";

function request(conversationId: string, body: unknown, sessionToken: string) {
  const headers = new Headers({
    "content-type": "application/json",
    origin: ORIGIN,
    [CSRF_HEADER]: CSRF_TOKEN,
    cookie: `${CSRF_COOKIE}=${CSRF_TOKEN}; ${LOCAL_SESSION_COOKIE}=${sessionToken}`
  });
  return new NextRequest(`${ORIGIN}/api/conversations/${conversationId}/messages`, { method: "POST", headers, body: JSON.stringify(body) });
}

function post(conversationId: string, body: unknown, sessionToken: string) {
  return postMessage(request(conversationId, body, sessionToken), { params: Promise.resolve({ id: conversationId }) });
}

describe("concurrent conversation submissions", () => {
  let projectId: string;
  let sessionToken: string;

  beforeAll(async () => {
    const project = await prisma.project.create({
      data: { name: `concurrency-test-${randomUUID()}`, repositoryPath: `/tmp/concurrency-test-${randomUUID()}`, allowedCommands: [], permittedPaths: [] }
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

  async function newConversation(title: string) {
    return prisma.conversation.create({ data: { projectId, title } });
  }

  it("handles two simultaneous browser submissions to the same conversation without corrupting state", async () => {
    const conversation = await newConversation("Two simultaneous submissions");
    const [first, second] = await Promise.all([
      post(conversation.id, { content: "first message", provider: "codex-cli", mode: "ASK", idempotencyKey: randomUUID() }, sessionToken),
      post(conversation.id, { content: "second message", provider: "codex-cli", mode: "ASK", idempotencyKey: randomUUID() }, sessionToken)
    ]);
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    const firstBody = await first.json();
    const secondBody = await second.json();
    expect(firstBody.userMessage.id).not.toBe(secondBody.userMessage.id);

    const messages = await prisma.conversationMessage.findMany({ where: { conversationId: conversation.id, role: "USER" } });
    expect(messages).toHaveLength(2);
    const refreshed = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
    expect(refreshed.sequence).toBe(2);
  });

  it("treats a duplicate idempotency key as the same submission instead of creating new work", async () => {
    const conversation = await newConversation("Duplicate idempotency key");
    const idempotencyKey = randomUUID();
    const [first, second] = await Promise.all([
      post(conversation.id, { content: "hello", provider: "codex-cli", mode: "ASK", idempotencyKey }, sessionToken),
      post(conversation.id, { content: "hello", provider: "codex-cli", mode: "ASK", idempotencyKey }, sessionToken)
    ]);
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    const firstBody = await first.json();
    const secondBody = await second.json();
    expect(firstBody.userMessage.id).toBe(secondBody.userMessage.id);
    expect(firstBody.queuedExecution.agentSessionId).toBe(secondBody.queuedExecution.agentSessionId);
    expect([firstBody.duplicate, secondBody.duplicate].filter(Boolean)).toHaveLength(1);

    const messages = await prisma.conversationMessage.findMany({ where: { conversationId: conversation.id, role: "USER" } });
    expect(messages).toHaveLength(1);
    const sessions = await prisma.agentSession.findMany({ where: { conversationId: conversation.id } });
    expect(sessions).toHaveLength(1);
  });

  it("serializes same-provider concurrent submissions onto a single active provider session", async () => {
    const conversation = await newConversation("Same provider concurrent");
    const [first, second] = await Promise.all([
      post(conversation.id, { content: "first", provider: "codex-cli", mode: "ASK", idempotencyKey: randomUUID() }, sessionToken),
      post(conversation.id, { content: "second", provider: "codex-cli", mode: "ASK", idempotencyKey: randomUUID() }, sessionToken)
    ]);
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    const firstBody = await first.json();
    const secondBody = await second.json();
    expect(firstBody.providerSession.id).toBe(secondBody.providerSession.id);

    const runningSessions = await prisma.providerSession.findMany({ where: { conversationId: conversation.id, providerId: "codex-cli", status: "RUNNING" } });
    expect(runningSessions).toHaveLength(1);
  });

  it("allocates distinct handoff versions for concurrent provider-switch submissions", async () => {
    const conversation = await newConversation("Provider switch concurrent");
    const firstReply = await prisma.conversationMessage.create({ data: { conversationId: conversation.id, role: "ASSISTANT", providerId: "codex-cli", mode: "ASK", content: "prior codex reply", status: "COMPLETED" } });
    await prisma.conversation.update({ where: { id: conversation.id }, data: { activeProviderId: "codex-cli" } });

    // Two different conversations switching at "the same time" would each get version 1 for
    // their own conversation; to prove *this* conversation's handoff allocation is race-free,
    // fire two concurrent switch attempts that would otherwise both try to claim the same version.
    const [first, second] = await Promise.all([
      post(conversation.id, { content: "switch to claude", provider: "claude-cli", mode: "ASK", idempotencyKey: randomUUID() }, sessionToken),
      post(conversation.id, { content: "switch to claude too", provider: "claude-cli", mode: "ASK", idempotencyKey: randomUUID() }, sessionToken)
    ]);
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    const firstBody = await first.json();
    const secondBody = await second.json();
    expect(firstBody.handoffCapsule).not.toBeNull();
    expect(secondBody.handoffCapsule).not.toBeNull();
    expect(firstBody.handoffCapsule.version).not.toBe(secondBody.handoffCapsule.version);
    expect(new Set([firstBody.handoffCapsule.version, secondBody.handoffCapsule.version])).toEqual(new Set([1, 2]));

    const capsules = await prisma.handoffCapsule.findMany({ where: { conversationId: conversation.id } });
    expect(capsules).toHaveLength(2);
    expect(new Set(capsules.map(c => c.version)).size).toBe(2);
    expect(firstReply.id).toBeTruthy();
  });
});
