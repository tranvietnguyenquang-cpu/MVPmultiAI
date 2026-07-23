import { randomUUID } from "node:crypto";
import type { Job } from "bullmq";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma, queueConversationMessage } from "@project-relay/database";
import type { AgentSession as ProviderAgentSession, CodingProvider, ProviderProbe } from "@project-relay/providers";
import type { ConversationMessageJob, TaskCapsuleContent } from "@project-relay/shared";
import { processConversationMessage } from "./conversation-worker.js";

type FakeProviderOverrides = Partial<{
  available: boolean;
  authentication: ProviderProbe["authentication"];
  externalId: string;
  events: Array<{ type: "stdout" | "stderr"; message: string }>;
  startSession: CodingProvider["startSession"];
  streamEvents: CodingProvider["streamEvents"];
}>;

function makeFakeProvider(id: "codex-cli" | "claude-cli", overrides: FakeProviderOverrides = {}) {
  const events = overrides.events ?? [{ type: "stdout" as const, message: "ok" }];
  const capturedCapsules: TaskCapsuleContent[] = [];
  const createSession = vi.fn(async (input: { workspace: string; taskId: string; role?: string; resumeExternalId?: string }): Promise<ProviderAgentSession> => ({
    id: randomUUID(),
    providerId: id,
    workspace: input.workspace,
    taskId: input.taskId,
    role: (input.role as ProviderAgentSession["role"]) ?? "IMPLEMENTER",
    ...(overrides.externalId ? { externalId: overrides.externalId } : {})
  }));
  const defaultStartSession: CodingProvider["startSession"] = async (_session, capsule) => { capturedCapsules.push(capsule); };
  const startSession = vi.fn(overrides.startSession ?? defaultStartSession);
  const defaultStreamEvents: CodingProvider["streamEvents"] = async function* () {
    for (const item of events) yield { type: item.type, message: item.message, timestamp: new Date() };
  };
  const streamEvents = vi.fn(overrides.streamEvents ?? defaultStreamEvents);
  const provider: CodingProvider = {
    id,
    name: id === "codex-cli" ? "Codex CLI" : "Claude CLI",
    defaultRoles: ["IMPLEMENTER"],
    setupInstructions: "n/a",
    detectInstallation: async () => true,
    getVersion: async () => "1.0.0",
    refreshHealth: async () => ({ providerId: id, installed: true, authentication: "AUTHENTICATED", available: true, checkedAt: new Date(), quotaSource: "CLI_STATUS", quotaConfidence: "LOW", quotaExact: false }),
    probeAuthentication: vi.fn(async () => ({
      providerId: id,
      installed: true,
      authentication: overrides.authentication ?? "AUTHENTICATED",
      available: overrides.available ?? true,
      checkedAt: new Date(),
      quotaSource: "CLI_STATUS",
      quotaConfidence: "LOW",
      quotaExact: false
    } satisfies ProviderProbe)),
    testConnection: async () => { throw new Error("not used"); },
    createSession,
    startSession,
    sendTask: async (session, capsule, signal) => { await provider.startSession(session, capsule, signal); },
    streamEvents,
    cancelSession: vi.fn(async () => undefined),
    resumeSession: vi.fn(overrides.startSession ?? defaultStartSession),
    getUsage: vi.fn(async () => ({ estimated: true }))
  };
  return { provider, capturedCapsules, createSession, startSession, streamEvents };
}

function makeRegistry(providers: Record<string, CodingProvider>) {
  return { get: (id: string) => { const provider = providers[id]; if (!provider) throw new Error(`Unknown provider '${id}'.`); return provider; } };
}

type FreshQueueResult = Extract<Awaited<ReturnType<typeof queueConversationMessage>>, { duplicate: false }>;

async function queueTestMessage(input: {
  conversationId: string;
  projectId: string;
  content: string;
  mode?: "ASK" | "IMPLEMENT" | "REVIEW" | "CONTINUE" | "VERIFY";
  selectedProviderId: "codex-cli" | "claude-cli";
  previousAssistantMessage?: { id: string; providerId: string | null } | null;
}): Promise<{ result: FreshQueueResult; payload: ConversationMessageJob; job: Job<ConversationMessageJob> }> {
  const result = await queueConversationMessage({
    conversationId: input.conversationId,
    projectId: input.projectId,
    content: input.content,
    mode: input.mode ?? "ASK",
    selectedProviderId: input.selectedProviderId,
    reason: "test routing",
    providerHealthSnapshot: {},
    previousAssistantMessage: input.previousAssistantMessage ?? null,
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
  const job = { data: payload } as unknown as Job<ConversationMessageJob>;
  return { result, payload, job };
}

describe("conversation worker execution", () => {
  let projectId: string;

  beforeAll(async () => {
    const project = await prisma.project.create({
      data: {
        name: `conversation-worker-test-${randomUUID()}`,
        repositoryPath: `/tmp/conversation-worker-test-${randomUUID()}`,
        allowedCommands: [],
        permittedPaths: []
      }
    });
    projectId = project.id;
  });

  afterAll(async () => {
    await prisma.project.delete({ where: { id: projectId } }).catch(() => undefined);
  });

  async function newConversation(title: string) {
    return prisma.conversation.create({ data: { projectId, title } });
  }

  it("completes a queued Codex execution", async () => {
    const conversation = await newConversation("Codex completes");
    const fake = makeFakeProvider("codex-cli", { events: [{ type: "stdout", message: "CODEX_MARKER_RESPONSE" }] });
    const { payload } = await queueTestMessage({ conversationId: conversation.id, projectId, content: "hello codex", selectedProviderId: "codex-cli" });

    await processConversationMessage({ data: payload } as unknown as Job<ConversationMessageJob>, { registry: makeRegistry({ "codex-cli": fake.provider }) });

    const session = await prisma.agentSession.findUniqueOrThrow({ where: { id: payload.sessionId } });
    expect(session.state).toBe("SUCCEEDED");
    const assistant = await prisma.conversationMessage.findFirstOrThrow({ where: { conversationId: conversation.id, role: "ASSISTANT" } });
    expect(assistant.status).toBe("COMPLETED");
    expect(assistant.content).toContain("CODEX_MARKER_RESPONSE");
  });

  it("completes a queued Claude execution", async () => {
    const conversation = await newConversation("Claude completes");
    const fake = makeFakeProvider("claude-cli", { events: [{ type: "stdout", message: "CLAUDE_MARKER_RESPONSE" }] });
    const { payload } = await queueTestMessage({ conversationId: conversation.id, projectId, content: "hello claude", selectedProviderId: "claude-cli" });

    await processConversationMessage({ data: payload } as unknown as Job<ConversationMessageJob>, { registry: makeRegistry({ "claude-cli": fake.provider }) });

    const session = await prisma.agentSession.findUniqueOrThrow({ where: { id: payload.sessionId } });
    expect(session.state).toBe("SUCCEEDED");
    const assistant = await prisma.conversationMessage.findFirstOrThrow({ where: { conversationId: conversation.id, role: "ASSISTANT" } });
    expect(assistant.content).toContain("CLAUDE_MARKER_RESPONSE");
  });

  it("selects the persisted provider from the registry, not the other one", async () => {
    const conversation = await newConversation("Registry selection");
    const codex = makeFakeProvider("codex-cli");
    const claude = makeFakeProvider("claude-cli");
    const { payload } = await queueTestMessage({ conversationId: conversation.id, projectId, content: "hello", selectedProviderId: "claude-cli" });

    await processConversationMessage({ data: payload } as unknown as Job<ConversationMessageJob>, { registry: makeRegistry({ "codex-cli": codex.provider, "claude-cli": claude.provider }) });

    expect(claude.createSession).toHaveBeenCalledTimes(1);
    expect(codex.createSession).not.toHaveBeenCalled();
  });

  it("builds a prompt that includes the current request", async () => {
    const conversation = await newConversation("Prompt includes request");
    const fake = makeFakeProvider("codex-cli");
    const { payload } = await queueTestMessage({ conversationId: conversation.id, projectId, content: "please implement the widget", selectedProviderId: "codex-cli" });

    await processConversationMessage({ data: payload } as unknown as Job<ConversationMessageJob>, { registry: makeRegistry({ "codex-cli": fake.provider }) });

    expect(fake.capturedCapsules[0]?.task.userRequest).toBe("please implement the widget");
    expect(fake.capturedCapsules[0]?.conversationMode).toBe("ASK");
  });

  it("includes a compact handoff summary in the prompt when the provider switches", async () => {
    const conversation = await newConversation("Prompt includes handoff");
    const priorAssistant = await prisma.conversationMessage.create({ data: { conversationId: conversation.id, role: "ASSISTANT", providerId: "codex-cli", mode: "ASK", content: "codex reply", status: "COMPLETED" } });
    const claude = makeFakeProvider("claude-cli");
    const { payload } = await queueTestMessage({
      conversationId: conversation.id,
      projectId,
      content: "switch to claude please",
      selectedProviderId: "claude-cli",
      previousAssistantMessage: { id: priorAssistant.id, providerId: "codex-cli" }
    });
    expect(payload.handoffCapsuleId).toBeDefined();

    await processConversationMessage({ data: payload } as unknown as Job<ConversationMessageJob>, { registry: makeRegistry({ "claude-cli": claude.provider }) });

    expect(claude.capturedCapsules[0]?.handoff).toBeDefined();
    expect(claude.capturedCapsules[0]?.handoff?.fromProviderId).toBe("codex-cli");
    expect(claude.capturedCapsules[0]?.handoff?.toProviderId).toBe("claude-cli");
  });

  it("excludes unrelated old raw messages from the prompt", async () => {
    const conversation = await newConversation("Prompt excludes old history");
    await prisma.conversationMessage.create({ data: { conversationId: conversation.id, role: "USER", mode: "ASK", content: "OLD_UNRELATED_SECRET_TEXT_12345", status: "COMPLETED" } });
    const fake = makeFakeProvider("codex-cli");
    const { payload } = await queueTestMessage({ conversationId: conversation.id, projectId, content: "a brand new unrelated request", selectedProviderId: "codex-cli" });

    await processConversationMessage({ data: payload } as unknown as Job<ConversationMessageJob>, { registry: makeRegistry({ "codex-cli": fake.provider }) });

    expect(JSON.stringify(fake.capturedCapsules[0])).not.toContain("OLD_UNRELATED_SECRET_TEXT_12345");
  });

  it("records correct provider attribution on the assistant message", async () => {
    const conversation = await newConversation("Provider attribution");
    const fake = makeFakeProvider("claude-cli");
    const { payload, result } = await queueTestMessage({ conversationId: conversation.id, projectId, content: "hello", selectedProviderId: "claude-cli" });

    await processConversationMessage({ data: payload } as unknown as Job<ConversationMessageJob>, { registry: makeRegistry({ "claude-cli": fake.provider }) });

    const assistant = await prisma.conversationMessage.findFirstOrThrow({ where: { conversationId: conversation.id, role: "ASSISTANT" } });
    expect(assistant.providerId).toBe("claude-cli");
    expect(assistant.providerSessionId).toBe(result.providerSession.id);
    expect(assistant.agentSessionId).toBe(result.agentSession.id);
  });

  it("keeps Codex and Claude external session IDs isolated", async () => {
    const conversation = await newConversation("Session isolation");
    const codex = makeFakeProvider("codex-cli", { externalId: "codex-external-1" });
    const claude = makeFakeProvider("claude-cli", { externalId: "claude-external-1" });

    const first = await queueTestMessage({ conversationId: conversation.id, projectId, content: "hello codex", selectedProviderId: "codex-cli" });
    await processConversationMessage({ data: first.payload } as unknown as Job<ConversationMessageJob>, { registry: makeRegistry({ "codex-cli": codex.provider }) });

    const second = await queueTestMessage({ conversationId: conversation.id, projectId, content: "hello claude", selectedProviderId: "claude-cli" });
    await processConversationMessage({ data: second.payload } as unknown as Job<ConversationMessageJob>, { registry: makeRegistry({ "claude-cli": claude.provider }) });

    const codexSession = await prisma.providerSession.findUniqueOrThrow({ where: { id: first.result.providerSession.id } });
    const claudeSession = await prisma.providerSession.findUniqueOrThrow({ where: { id: second.result.providerSession.id } });
    expect(codexSession.externalSessionId).toBe("codex-external-1");
    expect(claudeSession.externalSessionId).toBe("claude-external-1");
    expect(codexSession.id).not.toBe(claudeSession.id);
  });

  it("persists events in the order they were streamed", async () => {
    const conversation = await newConversation("Event ordering");
    const fake = makeFakeProvider("codex-cli", { events: [{ type: "stdout", message: "step-one" }, { type: "stdout", message: "step-two" }, { type: "stdout", message: "step-three" }] });
    const { payload } = await queueTestMessage({ conversationId: conversation.id, projectId, content: "hello", selectedProviderId: "codex-cli" });

    await processConversationMessage({ data: payload } as unknown as Job<ConversationMessageJob>, { registry: makeRegistry({ "codex-cli": fake.provider }) });

    const events = await prisma.agentEvent.findMany({ where: { sessionId: payload.sessionId, type: "stdout" }, orderBy: { id: "asc" } });
    expect(events.map(item => item.message)).toEqual(["step-one", "step-two", "step-three"]);
  });

  it("persists a provider failure safely without marking completion", async () => {
    const conversation = await newConversation("Provider failure");
    const fake = makeFakeProvider("codex-cli", { available: false, authentication: "NOT_AUTHENTICATED" });
    const { payload } = await queueTestMessage({ conversationId: conversation.id, projectId, content: "hello", selectedProviderId: "codex-cli" });

    await expect(processConversationMessage({ data: payload } as unknown as Job<ConversationMessageJob>, { registry: makeRegistry({ "codex-cli": fake.provider }) })).rejects.toThrow();

    const session = await prisma.agentSession.findUniqueOrThrow({ where: { id: payload.sessionId } });
    expect(session.state).toBe("FAILED");
    expect(session.error).toBeTruthy();
    const assistant = await prisma.conversationMessage.findFirstOrThrow({ where: { conversationId: conversation.id, role: "ASSISTANT" } });
    expect(assistant.status).toBe("FAILED");
    const userMessage = await prisma.conversationMessage.findFirstOrThrow({ where: { conversationId: conversation.id, role: "USER" } });
    expect(userMessage).toBeTruthy();
  });

  it("fails safely when the provider yields malformed output mid-stream", async () => {
    const conversation = await newConversation("Malformed output");
    const brokenStream: CodingProvider["streamEvents"] = async function* () {
      yield { type: "stdout", message: "partial-chunk", timestamp: new Date() };
      throw new Error("malformed provider output");
    };
    const fake = makeFakeProvider("codex-cli", { streamEvents: brokenStream });
    const { payload } = await queueTestMessage({ conversationId: conversation.id, projectId, content: "hello", selectedProviderId: "codex-cli" });

    await expect(processConversationMessage({ data: payload } as unknown as Job<ConversationMessageJob>, { registry: makeRegistry({ "codex-cli": fake.provider }) })).rejects.toThrow();

    const session = await prisma.agentSession.findUniqueOrThrow({ where: { id: payload.sessionId } });
    expect(session.state).toBe("FAILED");
  });

  it("classifies a hung provider as a timeout", async () => {
    const conversation = await newConversation("Timeout classification");
    const hangingStart: CodingProvider["startSession"] = (_session, _capsule, signal) => new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("process killed")));
    });
    const fake = makeFakeProvider("codex-cli", { startSession: hangingStart, streamEvents: async function* () { await new Promise(() => undefined); } });
    const { payload } = await queueTestMessage({ conversationId: conversation.id, projectId, content: "hello", selectedProviderId: "codex-cli" });

    await expect(processConversationMessage({ data: payload } as unknown as Job<ConversationMessageJob>, { registry: makeRegistry({ "codex-cli": fake.provider }), timeoutMs: 30 })).rejects.toThrow(/timed out/i);

    const session = await prisma.agentSession.findUniqueOrThrow({ where: { id: payload.sessionId } });
    expect(session.state).toBe("FAILED");
    expect(session.error).toMatch(/timed out/i);
  }, 10_000);

  it("enforces an output limit on the persisted assistant message", async () => {
    const conversation = await newConversation("Output limit");
    const fake = makeFakeProvider("codex-cli", { events: [{ type: "stdout", message: "x".repeat(200_000) }] });
    const { payload } = await queueTestMessage({ conversationId: conversation.id, projectId, content: "hello", selectedProviderId: "codex-cli" });

    await processConversationMessage({ data: payload } as unknown as Job<ConversationMessageJob>, { registry: makeRegistry({ "codex-cli": fake.provider }) });

    const assistant = await prisma.conversationMessage.findFirstOrThrow({ where: { conversationId: conversation.id, role: "ASSISTANT" } });
    expect(assistant.content.length).toBeLessThanOrEqual(65_536);
  });

  it("redacts a secret split across stream chunks", async () => {
    const conversation = await newConversation("Split secret redaction");
    const fake = makeFakeProvider("codex-cli", { events: [{ type: "stdout", message: "token=sk-abcde" }, { type: "stdout", message: "fghijklmnopqr and more text" }] });
    const { payload } = await queueTestMessage({ conversationId: conversation.id, projectId, content: "hello", selectedProviderId: "codex-cli" });

    await processConversationMessage({ data: payload } as unknown as Job<ConversationMessageJob>, { registry: makeRegistry({ "codex-cli": fake.provider }) });

    const assistant = await prisma.conversationMessage.findFirstOrThrow({ where: { conversationId: conversation.id, role: "ASSISTANT" } });
    expect(assistant.content).toContain("[REDACTED]");
    expect(assistant.content).not.toContain("sk-abcdefghijklmnopqr");
  });

  it("is idempotent under a concurrent duplicate worker delivery", async () => {
    const conversation = await newConversation("Concurrent duplicate delivery");
    const fake = makeFakeProvider("codex-cli");
    const { payload } = await queueTestMessage({ conversationId: conversation.id, projectId, content: "hello", selectedProviderId: "codex-cli" });

    await Promise.all([
      processConversationMessage({ data: payload } as unknown as Job<ConversationMessageJob>, { registry: makeRegistry({ "codex-cli": fake.provider }) }),
      processConversationMessage({ data: payload } as unknown as Job<ConversationMessageJob>, { registry: makeRegistry({ "codex-cli": fake.provider }) })
    ]);

    expect(fake.createSession).toHaveBeenCalledTimes(1);
    const assistants = await prisma.conversationMessage.findMany({ where: { conversationId: conversation.id, role: "ASSISTANT" } });
    expect(assistants).toHaveLength(1);
  });

  it("does not create a second assistant message on a late duplicate completion", async () => {
    const conversation = await newConversation("Late duplicate delivery");
    const fake = makeFakeProvider("codex-cli");
    const { payload } = await queueTestMessage({ conversationId: conversation.id, projectId, content: "hello", selectedProviderId: "codex-cli" });

    await processConversationMessage({ data: payload } as unknown as Job<ConversationMessageJob>, { registry: makeRegistry({ "codex-cli": fake.provider }) });
    await processConversationMessage({ data: payload } as unknown as Job<ConversationMessageJob>, { registry: makeRegistry({ "codex-cli": fake.provider }) });

    expect(fake.createSession).toHaveBeenCalledTimes(1);
    const assistants = await prisma.conversationMessage.findMany({ where: { conversationId: conversation.id, role: "ASSISTANT" } });
    expect(assistants).toHaveLength(1);
  });
});
