import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "./index.js";
import {
  closeProviderSession,
  createAssistantMessage,
  createConversation,
  createHandoffCapsule,
  createRoutingDecision,
  createUserMessage,
  getConversationWithDetails,
  getOrCreateProviderSession,
  handoffChecksum,
  listConversationMessages,
  listProjectConversations,
  queueConversationMessage,
  retryConversationExecution,
} from "./conversation-service.js";

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe("conversation service: handoffChecksum", () => {
  it("is deterministic independent of object key order", () => {
    expect(handoffChecksum({ b: 2, a: { z: 1, y: 2 } })).toBe(handoffChecksum({ a: { y: 2, z: 1 }, b: 2 }));
  });

  it("changes when the payload changes", () => {
    expect(handoffChecksum({ a: 1 })).not.toBe(handoffChecksum({ a: 2 }));
  });
});

describe("conversation service: database-backed operations", () => {
  let projectId: string;

  beforeAll(async () => {
    const project = await prisma.project.create({
      data: {
        name: `conversation-service-test-${randomUUID()}`,
        repositoryPath: `/tmp/conversation-service-test-${randomUUID()}`,
        allowedCommands: [],
        permittedPaths: [],
        isVerification: true,
      },
    });
    projectId = project.id;
  });

  afterAll(async () => {
    await prisma.project.delete({ where: { id: projectId } });
  });

  it("creates a conversation and lists it for its project", async () => {
    const conversation = await createConversation(projectId, "First conversation");
    expect(conversation.projectId).toBe(projectId);
    expect(conversation.status).toBe("ACTIVE");

    const conversations = await listProjectConversations(projectId);
    expect(conversations.some(c => c.id === conversation.id)).toBe(true);
  });

  it("lists conversations for a project ordered by most recently updated", async () => {
    const older = await createConversation(projectId, "Older conversation");
    await wait(5);
    const newer = await createConversation(projectId, "Newer conversation");

    const conversations = await listProjectConversations(projectId);
    const olderIndex = conversations.findIndex(c => c.id === older.id);
    const newerIndex = conversations.findIndex(c => c.id === newer.id);
    expect(newerIndex).toBeLessThan(olderIndex);
  });

  it("stores messages and returns them in deterministic chronological order", async () => {
    const conversation = await createConversation(projectId, "Message ordering");

    const first = await createUserMessage(conversation.id, "first user message", "ASK");
    await wait(5);
    const second = await createAssistantMessage({
      conversationId: conversation.id,
      providerId: "codex-cli",
      mode: "ASK",
      content: "first assistant reply",
    });
    await wait(5);
    const third = await createUserMessage(conversation.id, "second user message", "IMPLEMENT");

    const messages = await listConversationMessages(conversation.id);
    expect(messages.map(m => m.id)).toEqual([first.id, second.id, third.id]);
    expect(messages.map(m => m.role)).toEqual(["USER", "ASSISTANT", "USER"]);
  });

  it("keeps Codex and Claude provider sessions separate and reuses a running session", async () => {
    const conversation = await createConversation(projectId, "Provider sessions");

    const codexSession = await getOrCreateProviderSession(conversation.id, "codex-cli");
    const claudeSession = await getOrCreateProviderSession(conversation.id, "claude-cli");
    expect(codexSession.id).not.toBe(claudeSession.id);
    expect(codexSession.providerId).toBe("codex-cli");
    expect(claudeSession.providerId).toBe("claude-cli");

    const codexSessionAgain = await getOrCreateProviderSession(conversation.id, "codex-cli");
    expect(codexSessionAgain.id).toBe(codexSession.id);

    await closeProviderSession(codexSession.id, "COMPLETED");
    const closed = await prisma.providerSession.findUniqueOrThrow({ where: { id: codexSession.id } });
    expect(closed.status).toBe("COMPLETED");
    expect(closed.endedAt).not.toBeNull();

    const freshCodexSession = await getOrCreateProviderSession(conversation.id, "codex-cli");
    expect(freshCodexSession.id).not.toBe(codexSession.id);
  });

  it("records routing decisions with and without a requested provider", async () => {
    const conversation = await createConversation(projectId, "Routing decisions");

    const decision = await createRoutingDecision(
      conversation.id,
      "codex-cli",
      "Codex CLI is authenticated and Claude CLI is rate limited.",
      { "codex-cli": { available: true }, "claude-cli": { available: false } },
      "claude-cli",
    );
    expect(decision.requestedProviderId).toBe("claude-cli");
    expect(decision.selectedProviderId).toBe("codex-cli");

    const decisionWithoutRequest = await createRoutingDecision(
      conversation.id,
      "codex-cli",
      "Only Codex CLI is configured.",
      { "codex-cli": { available: true } },
    );
    expect(decisionWithoutRequest.requestedProviderId).toBeNull();
  });

  it("creates versioned, checksummed handoff capsules", async () => {
    const conversation = await createConversation(projectId, "Handoff capsules");

    const baseInput = {
      conversationId: conversation.id,
      fromProviderId: "codex-cli",
      toProviderId: "claude-cli",
      objective: "Hand off implementation work to Claude for review.",
      relevantDecisions: { decisions: ["use-postgres"] },
      filesChanged: { files: ["packages/database/src/conversation-service.ts"] },
      gitBaseline: { commit: "abc123" },
      gitDiffSummary: "diff --git a/file b/file\n+added line",
      tests: { unit: "passed" },
      unresolvedIssues: { items: [] },
      acceptedFindings: { items: [] },
      sourceMessageRange: { fromMessageId: "m1", toMessageId: "m2" },
    };

    const first = await createHandoffCapsule(baseInput);
    expect(first.version).toBe(1);
    expect(first.checksum).toBe(handoffChecksum({ ...baseInput, gitDiffSummary: baseInput.gitDiffSummary, version: 1 }));

    const second = await createHandoffCapsule(baseInput);
    expect(second.version).toBe(2);
    expect(second.checksum).not.toBe(first.checksum);
  });

  it("rejects handoff capsules that exceed the bounded payload size", async () => {
    const conversation = await createConversation(projectId, "Oversized handoff capsule");

    await expect(
      createHandoffCapsule({
        conversationId: conversation.id,
        fromProviderId: "codex-cli",
        toProviderId: "claude-cli",
        objective: "Hand off an oversized capsule.",
        relevantDecisions: { decisions: [] },
        filesChanged: { files: [] },
        gitBaseline: { commit: "abc123" },
        gitDiffSummary: "x",
        tests: {},
        unresolvedIssues: {},
        acceptedFindings: {},
        sourceMessageRange: {},
      }).then(() =>
        createHandoffCapsule({
          conversationId: conversation.id,
          fromProviderId: "codex-cli",
          toProviderId: "claude-cli",
          objective: "Hand off an oversized capsule.",
          relevantDecisions: { decisions: Array.from({ length: 20_000 }, (_, i) => `decision-${i}`) },
          filesChanged: { files: [] },
          gitBaseline: { commit: "abc123" },
          gitDiffSummary: "x",
          tests: {},
          unresolvedIssues: {},
          acceptedFindings: {},
          sourceMessageRange: {},
        }),
      ),
    ).rejects.toThrow(/bounded payload size/);
  });

  it("returns a conversation with its nested details in deterministic order", async () => {
    const conversation = await createConversation(projectId, "Full detail view");
    await createUserMessage(conversation.id, "hello", "ASK");
    await wait(5);
    await createAssistantMessage({
      conversationId: conversation.id,
      providerId: "codex-cli",
      mode: "ASK",
      content: "hi there",
    });
    await createRoutingDecision(conversation.id, "codex-cli", "default provider", {});
    await createHandoffCapsule({
      conversationId: conversation.id,
      fromProviderId: "codex-cli",
      toProviderId: "claude-cli",
      objective: "test",
      relevantDecisions: {},
      filesChanged: {},
      gitBaseline: {},
      gitDiffSummary: "",
      tests: {},
      unresolvedIssues: {},
      acceptedFindings: {},
      sourceMessageRange: {},
    });

    const details = await getConversationWithDetails(conversation.id);
    expect(details).not.toBeNull();
    expect(details?.messages).toHaveLength(2);
    expect(details?.messages.map(m => m.role)).toEqual(["USER", "ASSISTANT"]);
    expect(details?.routingDecisions).toHaveLength(1);
    expect(details?.handoffCapsules).toHaveLength(1);
    expect(details?.handoffCapsules[0]?.version).toBe(1);
  });

  it("rejects queueing an unknown provider/mode combination before creating any rows", async () => {
    const conversation = await createConversation(projectId, "Unsupported capability");

    await expect(
      queueConversationMessage({
        conversationId: conversation.id,
        projectId,
        content: "please implement this",
        mode: "IMPLEMENT",
        selectedProviderId: "gpt-4",
        reason: "test",
        providerHealthSnapshot: {},
        previousAssistantMessage: null,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow(/does not support IMPLEMENT/);

    const messages = await prisma.conversationMessage.findMany({ where: { conversationId: conversation.id } });
    expect(messages).toHaveLength(0);
    const sessions = await prisma.agentSession.findMany({ where: { conversationId: conversation.id } });
    expect(sessions).toHaveLength(0);
  });

  it("allows queueing Codex IMPLEMENT and persists workspace-write capability", async () => {
    const conversation = await createConversation(projectId, "Codex implement allowed");

    const result = await queueConversationMessage({
      conversationId: conversation.id,
      projectId,
      content: "please implement this",
      mode: "IMPLEMENT",
      selectedProviderId: "codex-cli",
      reason: "test",
      providerHealthSnapshot: {},
      previousAssistantMessage: null,
      idempotencyKey: randomUUID(),
    });
    expect(result.duplicate).toBe(false);
    if (result.duplicate) throw new Error("unreachable");
    expect(result.agentSession.capability).toBe("WORKSPACE_WRITE");
  });

  it("allows queueing Claude IMPLEMENT and persists workspace-write capability", async () => {
    const conversation = await createConversation(projectId, "Claude implement allowed");

    const result = await queueConversationMessage({
      conversationId: conversation.id,
      projectId,
      content: "please implement this",
      mode: "IMPLEMENT",
      selectedProviderId: "claude-cli",
      reason: "test",
      providerHealthSnapshot: {},
      previousAssistantMessage: null,
      idempotencyKey: randomUUID(),
    });
    expect(result.duplicate).toBe(false);
    if (result.duplicate) throw new Error("unreachable");
    expect(result.agentSession.capability).toBe("WORKSPACE_WRITE");
  });

  it("keeps Claude ASK/REVIEW/VERIFY read-only", async () => {
    for (const mode of ["ASK", "REVIEW", "VERIFY"] as const) {
      const conversation = await createConversation(projectId, `Claude ${mode} read-only`);
      const result = await queueConversationMessage({
        conversationId: conversation.id,
        projectId,
        content: "hello",
        mode,
        selectedProviderId: "claude-cli",
        reason: "test",
        providerHealthSnapshot: {},
        previousAssistantMessage: null,
        idempotencyKey: randomUUID(),
      });
      expect(result.duplicate).toBe(false);
      if (result.duplicate) throw new Error("unreachable");
      expect(result.agentSession.capability).toBe("READ_ONLY");
    }
  });

  it("has Claude CONTINUE inherit the capability of the execution being continued", async () => {
    const conversation = await createConversation(projectId, "Claude continue inherits capability");
    const implementRun = await queueConversationMessage({
      conversationId: conversation.id,
      projectId,
      content: "please implement this",
      mode: "IMPLEMENT",
      selectedProviderId: "claude-cli",
      reason: "test",
      providerHealthSnapshot: {},
      previousAssistantMessage: null,
      idempotencyKey: randomUUID(),
    });
    if (implementRun.duplicate) throw new Error("unreachable");
    expect(implementRun.agentSession.capability).toBe("WORKSPACE_WRITE");

    const continueRun = await queueConversationMessage({
      conversationId: conversation.id,
      projectId,
      content: "keep going",
      mode: "CONTINUE",
      selectedProviderId: "claude-cli",
      reason: "test",
      providerHealthSnapshot: {},
      previousAssistantMessage: null,
      idempotencyKey: randomUUID(),
    });
    if (continueRun.duplicate) throw new Error("unreachable");
    expect(continueRun.agentSession.capability).toBe("WORKSPACE_WRITE");
  });

  it("keeps Codex CONTINUE read-only even after a Codex IMPLEMENT run (unchanged Codex behavior)", async () => {
    const conversation = await createConversation(projectId, "Codex continue stays read-only");
    const implementRun = await queueConversationMessage({
      conversationId: conversation.id,
      projectId,
      content: "please implement this",
      mode: "IMPLEMENT",
      selectedProviderId: "codex-cli",
      reason: "test",
      providerHealthSnapshot: {},
      previousAssistantMessage: null,
      idempotencyKey: randomUUID(),
    });
    if (implementRun.duplicate) throw new Error("unreachable");
    expect(implementRun.agentSession.capability).toBe("WORKSPACE_WRITE");

    const continueRun = await queueConversationMessage({
      conversationId: conversation.id,
      projectId,
      content: "keep going",
      mode: "CONTINUE",
      selectedProviderId: "codex-cli",
      reason: "test",
      providerHealthSnapshot: {},
      previousAssistantMessage: null,
      idempotencyKey: randomUUID(),
    });
    if (continueRun.duplicate) throw new Error("unreachable");
    expect(continueRun.agentSession.capability).toBe("READ_ONLY");
  });
});

describe("conversation service: per-execution model selection", () => {
  let projectId: string;

  beforeAll(async () => {
    const project = await prisma.project.create({
      data: {
        name: `conversation-service-model-test-${randomUUID()}`,
        repositoryPath: `/tmp/conversation-service-model-test-${randomUUID()}`,
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

  afterEach(async () => {
    await prisma.applicationSettings.deleteMany({ where: { id: "singleton" } });
    await prisma.project.update({ where: { id: projectId }, data: { defaultClaudeModel: null, defaultCodexModel: null, defaultCodexReasoningEffort: null } });
  });

  it("persists an explicitly selected model on the AgentSession, RoutingDecision, and ProviderSession", async () => {
    const conversation = await createConversation(projectId, "Explicit model persisted");
    const result = await queueConversationMessage({
      conversationId: conversation.id, projectId, content: "hello", mode: "ASK", selectedProviderId: "claude-cli",
      requestedModel: "opus", reason: "test", providerHealthSnapshot: {}, previousAssistantMessage: null, idempotencyKey: randomUUID(),
    });
    if (result.duplicate) throw new Error("unreachable");
    expect(result.agentSession.requestedModel).toBe("opus");
    expect(result.agentSession.modelSource).toBe("USER_SELECTED");
    expect(result.routingDecision?.requestedModel).toBe("opus");
    expect(result.routingDecision?.selectedModel).toBe("opus");
    expect(result.providerSession?.resolvedModel).toBe("opus");
  });

  it("rejects a model absent from the registry before creating any row", async () => {
    const conversation = await createConversation(projectId, "Unsupported model rejected");
    await expect(queueConversationMessage({
      conversationId: conversation.id, projectId, content: "hello", mode: "ASK", selectedProviderId: "claude-cli",
      requestedModel: "totally-not-a-real-model", reason: "test", providerHealthSnapshot: {}, previousAssistantMessage: null, idempotencyKey: randomUUID(),
    })).rejects.toThrow(/does not support model/i);
    const messages = await prisma.conversationMessage.findMany({ where: { conversationId: conversation.id } });
    expect(messages).toHaveLength(0);
    const sessions = await prisma.agentSession.findMany({ where: { conversationId: conversation.id } });
    expect(sessions).toHaveLength(0);
  });

  it("rejects a model that belongs to a different provider", async () => {
    const conversation = await createConversation(projectId, "Cross-provider model rejected");
    await expect(queueConversationMessage({
      conversationId: conversation.id, projectId, content: "hello", mode: "ASK", selectedProviderId: "codex-cli",
      requestedModel: "sonnet", reason: "test", providerHealthSnapshot: {}, previousAssistantMessage: null, idempotencyKey: randomUUID(),
    })).rejects.toThrow(/does not support model/i);
    const sessions = await prisma.agentSession.findMany({ where: { conversationId: conversation.id } });
    expect(sessions).toHaveLength(0);
  });

  it("bounds reasoning effort by the resolved model's own configured capability", async () => {
    const conversation = await createConversation(projectId, "Reasoning effort bounded");
    await expect(queueConversationMessage({
      conversationId: conversation.id, projectId, content: "hello", mode: "ASK", selectedProviderId: "codex-cli",
      requestedModel: "o3", requestedReasoningEffort: "not-a-real-effort", reason: "test", providerHealthSnapshot: {}, previousAssistantMessage: null, idempotencyKey: randomUUID(),
    })).rejects.toThrow(/does not support reasoning effort/i);

    const result = await queueConversationMessage({
      conversationId: conversation.id, projectId, content: "hello", mode: "ASK", selectedProviderId: "codex-cli",
      requestedModel: "o3", requestedReasoningEffort: "high", reason: "test", providerHealthSnapshot: {}, previousAssistantMessage: null, idempotencyKey: randomUUID(),
    });
    if (result.duplicate) throw new Error("unreachable");
    expect(result.agentSession.reasoningEffort).toBe("high");
  });

  it("falls back to the project default model when nothing is explicitly selected", async () => {
    await prisma.project.update({ where: { id: projectId }, data: { defaultClaudeModel: "sonnet" } });
    const conversation = await createConversation(projectId, "Project default model");
    const result = await queueConversationMessage({
      conversationId: conversation.id, projectId, content: "hello", mode: "ASK", selectedProviderId: "claude-cli",
      reason: "test", providerHealthSnapshot: {}, previousAssistantMessage: null, idempotencyKey: randomUUID(),
    });
    if (result.duplicate) throw new Error("unreachable");
    expect(result.agentSession.requestedModel).toBe("sonnet");
    expect(result.agentSession.modelSource).toBe("PROJECT_DEFAULT");
  });

  it("falls back to the application default model when there is no project default", async () => {
    await prisma.applicationSettings.upsert({ where: { id: "singleton" }, create: { id: "singleton", defaultClaudeModel: "opus" }, update: { defaultClaudeModel: "opus" } });
    const conversation = await createConversation(projectId, "Application default model");
    const result = await queueConversationMessage({
      conversationId: conversation.id, projectId, content: "hello", mode: "ASK", selectedProviderId: "claude-cli",
      reason: "test", providerHealthSnapshot: {}, previousAssistantMessage: null, idempotencyKey: randomUUID(),
    });
    if (result.duplicate) throw new Error("unreachable");
    expect(result.agentSession.requestedModel).toBe("opus");
    expect(result.agentSession.modelSource).toBe("SYSTEM_DEFAULT");
  });

  it("falls all the way through to the provider's own default (no --model flag) when nothing is configured anywhere", async () => {
    const conversation = await createConversation(projectId, "Provider default model");
    const result = await queueConversationMessage({
      conversationId: conversation.id, projectId, content: "hello", mode: "ASK", selectedProviderId: "claude-cli",
      reason: "test", providerHealthSnapshot: {}, previousAssistantMessage: null, idempotencyKey: randomUUID(),
    });
    if (result.duplicate) throw new Error("unreachable");
    expect(result.agentSession.requestedModel).toBeNull();
    expect(result.agentSession.modelSource).toBe("PROVIDER_DEFAULT");
  });

  it("reuses the same ProviderSession across turns using the identical model", async () => {
    const conversation = await createConversation(projectId, "Same model reuses session");
    const turn1 = await queueConversationMessage({
      conversationId: conversation.id, projectId, content: "hello", mode: "ASK", selectedProviderId: "claude-cli",
      requestedModel: "sonnet", reason: "test", providerHealthSnapshot: {}, previousAssistantMessage: null, idempotencyKey: randomUUID(),
    });
    if (turn1.duplicate) throw new Error("unreachable");
    const priorAssistant = await createAssistantMessage({ conversationId: conversation.id, providerId: "claude-cli", mode: "ASK", content: "reply" });
    const turn2 = await queueConversationMessage({
      conversationId: conversation.id, projectId, content: "again", mode: "ASK", selectedProviderId: "claude-cli",
      requestedModel: "sonnet", reason: "test", providerHealthSnapshot: {},
      previousAssistantMessage: { id: priorAssistant.id, providerId: "claude-cli" }, idempotencyKey: randomUUID(),
    });
    if (turn2.duplicate) throw new Error("unreachable");
    expect(turn2.providerSession?.id).toBe(turn1.providerSession?.id);
    expect(turn2.handoffCapsule).toBeNull();
  });

  it("starts a separate ProviderSession, and records a handoff, when the model changes on the same provider", async () => {
    const conversation = await createConversation(projectId, "Model change starts new session");
    const turn1 = await queueConversationMessage({
      conversationId: conversation.id, projectId, content: "hello", mode: "ASK", selectedProviderId: "claude-cli",
      requestedModel: "sonnet", reason: "test", providerHealthSnapshot: {}, previousAssistantMessage: null, idempotencyKey: randomUUID(),
    });
    if (turn1.duplicate) throw new Error("unreachable");
    const priorAssistant = await createAssistantMessage({ conversationId: conversation.id, providerId: "claude-cli", mode: "ASK", content: "reply" });
    const turn2 = await queueConversationMessage({
      conversationId: conversation.id, projectId, content: "switch model", mode: "ASK", selectedProviderId: "claude-cli",
      requestedModel: "opus", reason: "test", providerHealthSnapshot: {},
      previousAssistantMessage: { id: priorAssistant.id, providerId: "claude-cli" }, idempotencyKey: randomUUID(),
    });
    if (turn2.duplicate) throw new Error("unreachable");
    expect(turn2.providerSession?.id).not.toBe(turn1.providerSession?.id);
    expect(turn2.providerSession?.resolvedModel).toBe("opus");
    expect(turn2.handoffCapsule).not.toBeNull();
    expect(turn2.handoffCapsule?.fromModel).toBe("sonnet");
    expect(turn2.handoffCapsule?.toModel).toBe("opus");
    expect(turn2.handoffCapsule?.fromProviderId).toBe("claude-cli");
    expect(turn2.handoffCapsule?.toProviderId).toBe("claude-cli");
  });

  describe("retry preserves or re-resolves the model correctly", () => {
    it("preserves the original model on a same-provider retry", async () => {
      const conversation = await createConversation(projectId, "Retry preserves model");
      const original = await queueConversationMessage({
        conversationId: conversation.id, projectId, content: "hello", mode: "ASK", selectedProviderId: "claude-cli",
        requestedModel: "opus", reason: "test", providerHealthSnapshot: {}, previousAssistantMessage: null, idempotencyKey: randomUUID(),
      });
      if (original.duplicate) throw new Error("unreachable");
      await prisma.agentSession.update({ where: { id: original.agentSession.id }, data: { state: "FAILED" } });

      const retry = await retryConversationExecution({ executionId: original.agentSession.id, providerId: "claude-cli", idempotencyKey: randomUUID() });
      expect("requestedModel" in retry ? retry.requestedModel : undefined).toBe("opus");
    });

    it("re-resolves the model (rather than blindly copying an incompatible one) when a retry switches provider", async () => {
      const conversation = await createConversation(projectId, "Retry re-resolves across provider switch");
      const original = await queueConversationMessage({
        conversationId: conversation.id, projectId, content: "hello", mode: "ASK", selectedProviderId: "claude-cli",
        requestedModel: "opus", reason: "test", providerHealthSnapshot: {}, previousAssistantMessage: null, idempotencyKey: randomUUID(),
      });
      if (original.duplicate) throw new Error("unreachable");
      await prisma.agentSession.update({ where: { id: original.agentSession.id }, data: { state: "FAILED" } });

      const retry = await retryConversationExecution({ executionId: original.agentSession.id, providerId: "codex-cli", idempotencyKey: randomUUID() });
      expect("requestedModel" in retry ? retry.requestedModel : undefined).toBeNull();
      expect("modelSource" in retry ? retry.modelSource : undefined).toBe("PROVIDER_DEFAULT");
    });
  });
});
