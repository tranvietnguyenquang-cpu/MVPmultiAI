// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); }
}));

const findUniqueMock = vi.fn();
const getConversationWithDetailsMock = vi.fn();
const getProviderHealthDisplayMock = vi.fn();
const getActiveConversationExecutionMock = vi.fn();
vi.mock("@project-relay/database", () => ({
  prisma: { project: { findUnique: (...args: unknown[]) => findUniqueMock(...args) } },
  getConversationWithDetails: (...args: unknown[]) => getConversationWithDetailsMock(...args),
  getProviderHealthDisplay: (...args: unknown[]) => getProviderHealthDisplayMock(...args),
  getActiveConversationExecution: (...args: unknown[]) => getActiveConversationExecutionMock(...args)
}));

vi.mock("../../../../../components/conversation-chat", () => ({
  ConversationChat: (props: { messages: Array<{ id: string; content: string }> }) => (
    <div data-testid="messages">
      {props.messages.map(message => (
        <span key={message.id}>{message.content}</span>
      ))}
    </div>
  )
}));

import ConversationPage from "./page.js";

function conversationFixture() {
  return {
    id: "conversation-1",
    projectId: "project-1",
    title: "Test conversation",
    status: "ACTIVE",
    activeProviderId: null,
    messages: [
      { id: "m1", role: "USER", providerId: null, providerSessionId: null, agentSessionId: null, taskId: null, mode: "ASK", content: "hello there", status: "COMPLETED", handoffCapsuleId: null, createdAt: new Date("2026-01-01T00:00:00Z") },
      { id: "m2", role: "ASSISTANT", providerId: "codex-cli", providerSessionId: "ps1", agentSessionId: "as1", taskId: "t1", mode: "ASK", content: "codex reply", status: "COMPLETED", handoffCapsuleId: null, createdAt: new Date("2026-01-01T00:01:00Z") }
    ],
    providerSessions: [{ id: "ps1", providerId: "codex-cli", status: "RUNNING" }],
    handoffCapsules: [],
    routingDecisions: [{ id: "r1", requestedProviderId: "codex-cli", selectedProviderId: "codex-cli" }]
  };
}

describe("Conversation detail page", () => {
  beforeEach(() => {
    findUniqueMock.mockReset();
    getConversationWithDetailsMock.mockReset();
    getProviderHealthDisplayMock.mockReset();
    getActiveConversationExecutionMock.mockReset();
    findUniqueMock.mockResolvedValue({ id: "project-1", name: "Demo project" });
    getConversationWithDetailsMock.mockResolvedValue(conversationFixture());
    getProviderHealthDisplayMock.mockResolvedValue({
      "codex-cli": { installed: true, authentication: "AUTHENTICATED", available: true, version: "1.0" },
      "claude-cli": { installed: true, authentication: "AUTHENTICATED", available: true, version: "2.0" }
    });
    getActiveConversationExecutionMock.mockResolvedValue(null);
  });

  afterEach(() => cleanup());

  it("loads persisted messages from the real production data layer", async () => {
    const element = await ConversationPage({ params: Promise.resolve({ id: "project-1", conversationId: "conversation-1" }) });
    render(element);
    expect(screen.getByText("hello there")).toBeTruthy();
    expect(screen.getByText("codex reply")).toBeTruthy();
  });

  it("preserves the full persisted timeline across a simulated refresh", async () => {
    const firstLoad = await ConversationPage({ params: Promise.resolve({ id: "project-1", conversationId: "conversation-1" }) });
    const { unmount } = render(firstLoad);
    expect(screen.getByText("hello there")).toBeTruthy();
    expect(screen.getByText("codex reply")).toBeTruthy();
    unmount();

    const secondLoad = await ConversationPage({ params: Promise.resolve({ id: "project-1", conversationId: "conversation-1" }) });
    render(secondLoad);
    expect(screen.getByText("hello there")).toBeTruthy();
    expect(screen.getByText("codex reply")).toBeTruthy();
  });
});
