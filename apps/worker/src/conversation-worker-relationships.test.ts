import { randomUUID } from "node:crypto";
import type { Job } from "bullmq";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma, queueConversationMessage } from "@project-relay/database";
import type { CodingProvider, ProviderProbe } from "@project-relay/providers";
import type { ConversationMessageJob } from "@project-relay/shared";
import { processConversationMessage } from "./conversation-worker.js";

function makeFakeProvider(id: "codex-cli" | "claude-cli") {
  const createSession = vi.fn(async () => ({ id: randomUUID(), providerId: id, workspace: "/tmp/x", taskId: "t", role: "IMPLEMENTER" as const, capability: "READ_ONLY" as const }));
  const startSession = vi.fn(async () => undefined);
  const provider: CodingProvider = {
    id,
    name: id === "codex-cli" ? "Codex CLI" : "Claude CLI",
    defaultRoles: ["IMPLEMENTER"],
    setupInstructions: "n/a",
    detectInstallation: async () => true,
    getVersion: async () => "1.0.0",
    refreshHealth: async () => ({ providerId: id, installed: true, authentication: "AUTHENTICATED", available: true, checkedAt: new Date(), quotaSource: "CLI_STATUS", quotaConfidence: "LOW", quotaExact: false }),
    probeAuthentication: vi.fn(async () => ({ providerId: id, installed: true, authentication: "AUTHENTICATED", available: true, checkedAt: new Date(), quotaSource: "CLI_STATUS", quotaConfidence: "LOW", quotaExact: false } satisfies ProviderProbe)),
    testConnection: async () => { throw new Error("not used"); },
    createSession,
    startSession,
    sendTask: async () => undefined,
    streamEvents: async function* () { yield { type: "stdout" as const, message: "ok", timestamp: new Date() }; },
    cancelSession: vi.fn(async () => undefined),
    resumeSession: vi.fn(async () => undefined),
    getUsage: vi.fn(async () => ({ estimated: true }))
  };
  return { provider, createSession, startSession };
}

function makeRegistry(providers: Record<string, CodingProvider>) {
  return { get: vi.fn((id: string) => { const provider = providers[id]; if (!provider) throw new Error(`Unknown provider '${id}'.`); return provider; }) };
}

type FreshQueueResult = Extract<Awaited<ReturnType<typeof queueConversationMessage>>, { duplicate: false }>;

async function queueTestMessage(input: { conversationId: string; projectId: string; content?: string; selectedProviderId: "codex-cli" | "claude-cli" }): Promise<{ result: FreshQueueResult; payload: ConversationMessageJob }> {
  const result = await queueConversationMessage({
    conversationId: input.conversationId,
    projectId: input.projectId,
    content: input.content ?? "hello",
    mode: "ASK",
    selectedProviderId: input.selectedProviderId,
    reason: "test routing",
    providerHealthSnapshot: {},
    previousAssistantMessage: null,
    idempotencyKey: randomUUID()
  });
  if (result.duplicate) throw new Error("Expected a fresh (non-duplicate) queue result.");
  const payload: ConversationMessageJob = {
    sessionId: result.agentSession.id,
    taskId: result.taskId,
    conversationId: input.conversationId,
    messageId: result.userMessage.id,
    providerId: input.selectedProviderId,
    routingDecisionId: result.routingDecision.id,
    providerSessionId: result.providerSession.id,
    ...(result.handoffCapsule ? { handoffCapsuleId: result.handoffCapsule.id } : {})
  };
  return { result, payload };
}

describe("conversation worker relationship validation", () => {
  let projectId: string;
  let otherProjectId: string;

  beforeAll(async () => {
    const project = await prisma.project.create({
      data: { name: `worker-relationships-${randomUUID()}`, repositoryPath: `/tmp/worker-relationships-${randomUUID()}`, allowedCommands: [], permittedPaths: [] }
    });
    projectId = project.id;
    const otherProject = await prisma.project.create({
      data: { name: `worker-relationships-other-${randomUUID()}`, repositoryPath: `/tmp/worker-relationships-other-${randomUUID()}`, allowedCommands: [], permittedPaths: [] }
    });
    otherProjectId = otherProject.id;
  });

  afterAll(async () => {
    await prisma.project.delete({ where: { id: projectId } }).catch(() => undefined);
    await prisma.project.delete({ where: { id: otherProjectId } }).catch(() => undefined);
  });

  async function newConversation(pid: string, title: string) {
    return prisma.conversation.create({ data: { projectId: pid, title } });
  }

  async function expectRejectedWithoutInvokingProvider(payload: ConversationMessageJob, provider: ReturnType<typeof makeFakeProvider>, reason: RegExp = /cross-wired/i) {
    await expect(processConversationMessage({ data: payload } as unknown as Job<ConversationMessageJob>, { registry: makeRegistry({ "codex-cli": provider.provider, "claude-cli": provider.provider }) })).rejects.toThrow(reason);
    expect(provider.createSession).not.toHaveBeenCalled();
    expect(provider.startSession).not.toHaveBeenCalled();
    const session = await prisma.agentSession.findUniqueOrThrow({ where: { id: payload.sessionId } });
    expect(session.state).toBe("FAILED");
    expect(session.error).toMatch(reason);
  }

  it("rejects a payload whose conversationId does not match the agent session's own conversation", async () => {
    const conversation = await newConversation(projectId, "Conversation mismatch");
    const other = await newConversation(projectId, "Other conversation");
    const fake = makeFakeProvider("codex-cli");
    const { payload } = await queueTestMessage({ conversationId: conversation.id, projectId, selectedProviderId: "codex-cli" });
    await expectRejectedWithoutInvokingProvider({ ...payload, conversationId: other.id }, fake);
  });

  it("rejects a payload whose messageId does not match the agent session's own trigger message", async () => {
    const conversation = await newConversation(projectId, "Message mismatch");
    const fake = makeFakeProvider("codex-cli");
    const { payload } = await queueTestMessage({ conversationId: conversation.id, projectId, selectedProviderId: "codex-cli" });
    const unrelatedMessage = await prisma.conversationMessage.create({ data: { conversationId: conversation.id, role: "USER", mode: "ASK", content: "unrelated", status: "COMPLETED" } });
    await expectRejectedWithoutInvokingProvider({ ...payload, messageId: unrelatedMessage.id }, fake);
  });

  it("rejects a payload whose routingDecisionId belongs to a different conversation", async () => {
    const conversationA = await newConversation(projectId, "Routing decision A");
    const conversationB = await newConversation(projectId, "Routing decision B");
    const fake = makeFakeProvider("codex-cli");
    const { payload } = await queueTestMessage({ conversationId: conversationA.id, projectId, selectedProviderId: "codex-cli" });
    const other = await queueTestMessage({ conversationId: conversationB.id, projectId, selectedProviderId: "codex-cli" });
    await expectRejectedWithoutInvokingProvider({ ...payload, routingDecisionId: other.payload.routingDecisionId }, fake);
  });

  it("rejects a payload whose providerSessionId belongs to a different conversation", async () => {
    const conversationA = await newConversation(projectId, "Provider session A");
    const conversationB = await newConversation(projectId, "Provider session B");
    const fake = makeFakeProvider("codex-cli");
    const { payload } = await queueTestMessage({ conversationId: conversationA.id, projectId, selectedProviderId: "codex-cli" });
    const other = await queueTestMessage({ conversationId: conversationB.id, projectId, selectedProviderId: "codex-cli" });
    await expectRejectedWithoutInvokingProvider({ ...payload, providerSessionId: other.payload.providerSessionId }, fake);
  });

  it("rejects a payload whose handoffCapsuleId belongs to a different conversation", async () => {
    const conversationA = await newConversation(projectId, "Handoff A");
    const conversationB = await newConversation(projectId, "Handoff B");
    const fake = makeFakeProvider("claude-cli");

    await prisma.conversationMessage.create({ data: { conversationId: conversationA.id, role: "ASSISTANT", providerId: "codex-cli", mode: "ASK", content: "codex reply", status: "COMPLETED" } });
    const previousAssistant = await prisma.conversationMessage.findFirstOrThrow({ where: { conversationId: conversationA.id, role: "ASSISTANT" } });
    const switchResult = await queueConversationMessage({
      conversationId: conversationA.id,
      projectId,
      content: "switch to claude",
      mode: "ASK",
      selectedProviderId: "claude-cli",
      reason: "test",
      providerHealthSnapshot: {},
      previousAssistantMessage: { id: previousAssistant.id, providerId: "codex-cli" },
      idempotencyKey: randomUUID()
    });
    if (switchResult.duplicate || !switchResult.handoffCapsule) throw new Error("Expected a fresh handoff capsule.");

    const { payload } = await queueTestMessage({ conversationId: conversationB.id, projectId, selectedProviderId: "claude-cli" });
    await expectRejectedWithoutInvokingProvider({ ...payload, handoffCapsuleId: switchResult.handoffCapsule.id }, fake);
  });

  it("rejects a payload whose selected provider does not match the routing decision (provider mismatch)", async () => {
    const conversation = await newConversation(projectId, "Provider mismatch");
    const fake = makeFakeProvider("claude-cli");
    const { payload } = await queueTestMessage({ conversationId: conversation.id, projectId, selectedProviderId: "codex-cli" });
    // Simulate a stale/corrupted job payload claiming a different provider than what was actually decided and recorded on the AgentSession.
    await prisma.agentSession.update({ where: { id: payload.sessionId }, data: { providerId: "claude-cli" } });
    await expectRejectedWithoutInvokingProvider({ ...payload, providerId: "claude-cli" }, fake);
  });

  it("rejects a payload that crosses into another project's task", async () => {
    const conversation = await newConversation(projectId, "Cross-project task");
    const otherConversation = await newConversation(otherProjectId, "Other project conversation");
    const fake = makeFakeProvider("codex-cli");
    const { payload } = await queueTestMessage({ conversationId: conversation.id, projectId, selectedProviderId: "codex-cli" });
    const otherQueued = await queueTestMessage({ conversationId: otherConversation.id, projectId: otherProjectId, selectedProviderId: "codex-cli" });
    await expectRejectedWithoutInvokingProvider({ ...payload, taskId: otherQueued.payload.taskId }, fake);

    // Confirm the other project's own conversation/messages were never touched by the rejected run.
    const otherMessages = await prisma.conversationMessage.findMany({ where: { conversationId: otherConversation.id } });
    expect(otherMessages.every(message => message.role !== "ASSISTANT")).toBe(true);
  });

  it("rejects a stale payload whose mode is unsupported for the recorded provider (Claude IMPLEMENT) without invoking the provider", async () => {
    const conversation = await newConversation(projectId, "Unsupported capability");
    const fake = makeFakeProvider("claude-cli");
    const { payload } = await queueTestMessage({ conversationId: conversation.id, projectId, selectedProviderId: "claude-cli" });
    // queueConversationMessage itself refuses to create a Claude+IMPLEMENT execution; simulate a
    // stale/corrupted payload that reaches the worker with an unsupported mode anyway (e.g. a
    // message row mutated after routing, or a payload replayed from an older, looser producer).
    await prisma.conversationMessage.update({ where: { id: payload.messageId }, data: { mode: "IMPLEMENT" } });
    await expectRejectedWithoutInvokingProvider(payload, fake, /unsupported execution/i);
  });

  it("enforces at most one assistant message per AgentSession at the database level", async () => {
    const conversation = await newConversation(projectId, "Unique assistant per session");
    const { payload, result } = await queueTestMessage({ conversationId: conversation.id, projectId, selectedProviderId: "codex-cli" });
    await prisma.conversationMessage.create({
      data: { conversationId: conversation.id, role: "ASSISTANT", providerId: "codex-cli", mode: "ASK", content: "first reply", status: "COMPLETED", agentSessionId: result.agentSession.id }
    });
    await expect(
      prisma.conversationMessage.create({
        data: { conversationId: conversation.id, role: "ASSISTANT", providerId: "codex-cli", mode: "ASK", content: "second reply", status: "COMPLETED", agentSessionId: result.agentSession.id }
      })
    ).rejects.toThrow(/Unique constraint/i);
    expect(payload.sessionId).toBe(result.agentSession.id);
  });

  it("is idempotent when multiple worker instances receive the same duplicate job concurrently", async () => {
    const conversation = await newConversation(projectId, "Multiple workers duplicate job");
    const fake = makeFakeProvider("codex-cli");
    const { payload } = await queueTestMessage({ conversationId: conversation.id, projectId, selectedProviderId: "codex-cli" });
    const registry = makeRegistry({ "codex-cli": fake.provider });

    await Promise.all([
      processConversationMessage({ data: payload } as unknown as Job<ConversationMessageJob>, { registry }),
      processConversationMessage({ data: payload } as unknown as Job<ConversationMessageJob>, { registry }),
      processConversationMessage({ data: payload } as unknown as Job<ConversationMessageJob>, { registry })
    ]);

    expect(fake.createSession).toHaveBeenCalledTimes(1);
    const assistants = await prisma.conversationMessage.findMany({ where: { conversationId: conversation.id, role: "ASSISTANT" } });
    expect(assistants).toHaveLength(1);
    const session = await prisma.agentSession.findUniqueOrThrow({ where: { id: payload.sessionId } });
    expect(session.state).toBe("SUCCEEDED");
  });
});
