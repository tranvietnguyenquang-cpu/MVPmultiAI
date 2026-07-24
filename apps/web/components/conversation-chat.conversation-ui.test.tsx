// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const refreshMock = vi.fn();
const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock, push: pushMock })
}));

const csrfFetchMock = vi.fn();
vi.mock("../lib/csrf-client", () => ({ csrfFetch: (...args: unknown[]) => csrfFetchMock(...args) }));

import { ConversationChat, type ConversationMessageView, type HandoffCapsuleView } from "./conversation-chat.js";

const HEALTHY_PROVIDER_HEALTH = {
  "codex-cli": { installed: true, authentication: "AUTHENTICATED", available: true, version: "codex 1.0" },
  "claude-cli": { installed: true, authentication: "AUTHENTICATED", available: true, version: "claude 2.0" }
};

function baseProps(overrides: Partial<Parameters<typeof ConversationChat>[0]> = {}) {
  return {
    projectId: "project-1",
    conversationId: "conversation-1",
    conversationTitle: "Test conversation",
    messages: [] as ConversationMessageView[],
    handoffCapsules: [] as HandoffCapsuleView[],
    providerSessions: [],
    providerHealth: HEALTHY_PROVIDER_HEALTH,
    initialActiveExecutionId: null,
    ...overrides
  };
}

function makeMessage(overrides: Partial<ConversationMessageView> = {}): ConversationMessageView {
  return {
    id: "msg-1",
    role: "USER",
    providerId: null,
    providerSessionId: null,
    agentSessionId: null,
    taskId: null,
    mode: "ASK",
    content: "hello",
    status: "COMPLETED",
    handoffCapsuleId: null,
    createdAt: new Date().toISOString(),
    ...overrides
  };
}

describe("ConversationChat", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    csrfFetchMock.mockReset();
    refreshMock.mockReset();
    pushMock.mockReset();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ status: "QUEUED", selectedProvider: "codex-cli", providerSession: null, events: [], assistantMessage: null, error: null }) })));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("lets the user select Codex", () => {
    render(<ConversationChat {...baseProps()} />);
    const select = screen.getByLabelText("Provider") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "codex-cli" } });
    expect(select.value).toBe("codex-cli");
  });

  it("lets the user select Claude", () => {
    render(<ConversationChat {...baseProps()} />);
    const select = screen.getByLabelText("Provider") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "claude-cli" } });
    expect(select.value).toBe("claude-cli");
  });

  it("lets the user select Auto", () => {
    render(<ConversationChat {...baseProps()} />);
    const select = screen.getByLabelText("Provider") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "codex-cli" } });
    fireEvent.change(select, { target: { value: "auto" } });
    expect(select.value).toBe("auto");
  });

  it("lets the user select every supported mode", () => {
    render(<ConversationChat {...baseProps()} />);
    const select = screen.getByLabelText("Mode") as HTMLSelectElement;
    for (const mode of ["ASK", "IMPLEMENT", "REVIEW", "CONTINUE", "VERIFY"]) {
      fireEvent.change(select, { target: { value: mode } });
      expect(select.value).toBe(mode);
    }
  });

  it("rejects an empty message without calling the API", async () => {
    render(<ConversationChat {...baseProps()} />);
    fireEvent.submit(screen.getByRole("button", { name: /send/i }).closest("form")!);
    await waitFor(() => expect(screen.getByText("Message cannot be empty.")).toBeTruthy());
    expect(csrfFetchMock).not.toHaveBeenCalled();
  });

  it("creates a visible queued message after sending", async () => {
    csrfFetchMock.mockResolvedValue({ ok: true, json: async () => ({ queuedExecution: { agentSessionId: "exec-1" } }) });
    render(<ConversationChat {...baseProps()} />);
    fireEvent.change(screen.getByPlaceholderText(/ask, implement, review/i), { target: { value: "please help" } });
    fireEvent.submit(screen.getByRole("button", { name: /send/i }).closest("form")!);
    await waitFor(() => expect(screen.getByText("Awaiting response…")).toBeTruthy());
  });

  it("updates the execution status as polling responses arrive", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ status: "RUNNING", selectedProvider: "codex-cli", providerSession: null, events: [], assistantMessage: null, error: null }) })));
    render(<ConversationChat {...baseProps({ initialActiveExecutionId: "exec-1" })} />);
    await waitFor(() => expect(screen.getByText("RUNNING")).toBeTruthy());
  });

  it("clears the pending execution and refreshes once the run completes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ status: "SUCCEEDED", selectedProvider: "codex-cli", providerSession: null, events: [], assistantMessage: null, error: null }) })));
    render(<ConversationChat {...baseProps({ initialActiveExecutionId: "exec-1" })} />);
    await waitFor(() => expect(refreshMock).toHaveBeenCalled());
    expect(screen.queryByText("Awaiting response…")).toBeNull();
  });

  it("renders the correct provider badge for Codex and Claude", () => {
    render(
      <ConversationChat
        {...baseProps({
          messages: [
            makeMessage({ id: "a1", role: "ASSISTANT", providerId: "codex-cli", content: "codex reply" }),
            makeMessage({ id: "a2", role: "ASSISTANT", providerId: "claude-cli", content: "claude reply" })
          ]
        })}
      />
    );
    expect(document.querySelector(".badge.codex-cli")?.textContent).toBe("Codex");
    expect(document.querySelector(".badge.claude-cli")?.textContent).toBe("Claude");
  });

  it("keeps a Codex → Claude switch inside a single timeline", () => {
    render(
      <ConversationChat
        {...baseProps({
          messages: [
            makeMessage({ id: "u1", role: "USER", content: "first" }),
            makeMessage({ id: "a1", role: "ASSISTANT", providerId: "codex-cli", content: "codex reply" }),
            makeMessage({ id: "u2", role: "USER", content: "second" }),
            makeMessage({ id: "a2", role: "ASSISTANT", providerId: "claude-cli", content: "claude reply", handoffCapsuleId: "capsule-1" })
          ],
          handoffCapsules: [
            { id: "capsule-1", fromProviderId: "codex-cli", toProviderId: "claude-cli", version: 1, checksum: "abcdef0123456789", sourceMessageRange: { fromMessageId: "a1", toMessageId: "u2" }, sizeBytes: 512, createdAt: new Date().toISOString() }
          ]
        })}
      />
    );
    const timeline = document.querySelector(".timeline")!;
    expect(within(timeline as HTMLElement).getByText("Codex")).toBeTruthy();
    expect(within(timeline as HTMLElement).getByText("Claude")).toBeTruthy();
  });

  it("keeps a Claude → Codex switch inside a single timeline", () => {
    render(
      <ConversationChat
        {...baseProps({
          messages: [
            makeMessage({ id: "u1", role: "USER", content: "first" }),
            makeMessage({ id: "a1", role: "ASSISTANT", providerId: "claude-cli", content: "claude reply" }),
            makeMessage({ id: "u2", role: "USER", content: "second" }),
            makeMessage({ id: "a2", role: "ASSISTANT", providerId: "codex-cli", content: "codex reply", handoffCapsuleId: "capsule-1" })
          ],
          handoffCapsules: [
            { id: "capsule-1", fromProviderId: "claude-cli", toProviderId: "codex-cli", version: 1, checksum: "abcdef0123456789", sourceMessageRange: { fromMessageId: "a1", toMessageId: "u2" }, sizeBytes: 512, createdAt: new Date().toISOString() }
          ]
        })}
      />
    );
    const timeline = document.querySelector(".timeline")!;
    expect(within(timeline as HTMLElement).getByText("Codex")).toBeTruthy();
    expect(within(timeline as HTMLElement).getByText("Claude")).toBeTruthy();
  });

  it("shows the handoff indicator only on the message where the provider changed", () => {
    render(
      <ConversationChat
        {...baseProps({
          messages: [
            makeMessage({ id: "a1", role: "ASSISTANT", providerId: "codex-cli", content: "codex reply" }),
            makeMessage({ id: "a2", role: "ASSISTANT", providerId: "claude-cli", content: "claude reply", handoffCapsuleId: "capsule-1" })
          ],
          handoffCapsules: [
            { id: "capsule-1", fromProviderId: "codex-cli", toProviderId: "claude-cli", version: 1, checksum: "abcdef0123456789", sourceMessageRange: { fromMessageId: "a1", toMessageId: "a2" }, sizeBytes: 512, createdAt: new Date().toISOString() }
          ]
        })}
      />
    );
    expect(document.querySelectorAll(".handoff-note")).toHaveLength(1);
  });

  it("renders a sanitized error for a failed execution without exposing internals", () => {
    render(
      <ConversationChat
        {...baseProps({
          messages: [makeMessage({ id: "a1", role: "ASSISTANT", providerId: "codex-cli", status: "FAILED", content: "Codex is not currently available." })]
        })}
      />
    );
    expect(screen.getByText("Codex is not currently available.")).toBeTruthy();
    expect(screen.queryByText(/PrismaClientKnownRequestError/i)).toBeNull();
    expect(screen.queryByText(/at\s+\S+\.(js|ts):\d+/)).toBeNull();
  });

  it("renders a clear provider-unavailable composer error", async () => {
    csrfFetchMock.mockResolvedValue({ ok: false, json: async () => ({ error: "codex-cli is not currently available." }) });
    render(<ConversationChat {...baseProps()} />);
    fireEvent.change(screen.getByPlaceholderText(/ask, implement, review/i), { target: { value: "please help" } });
    fireEvent.submit(screen.getByRole("button", { name: /send/i }).closest("form")!);
    await waitFor(() => expect(screen.getByText("codex-cli is not currently available.")).toBeTruthy());
  });

  it("replaces rather than duplicates streamed events on repeated polls", async () => {
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      call += 1;
      const events =
        call === 1
          ? [{ id: "1", type: "stdout", stream: "stdout", message: "first-chunk", createdAt: new Date().toISOString() }]
          : [
              { id: "1", type: "stdout", stream: "stdout", message: "first-chunk", createdAt: new Date().toISOString() },
              { id: "2", type: "stdout", stream: "stdout", message: "second-chunk", createdAt: new Date().toISOString() }
            ];
      return { ok: true, json: async () => ({ status: "RUNNING", selectedProvider: "codex-cli", providerSession: null, events, assistantMessage: null, error: null }) };
    }));
    render(<ConversationChat {...baseProps({ initialActiveExecutionId: "exec-1" })} />);
    await waitFor(() => expect(screen.getByText(/first-chunk/)).toBeTruthy());
    const occurrencesAfterFirstPoll = document.body.textContent!.split("first-chunk").length - 1;
    expect(occurrencesAfterFirstPoll).toBe(1);
  });

  it("shows the workspace-write safety label only for an explicit Claude + Implement selection", () => {
    render(<ConversationChat {...baseProps()} />);
    const providerSelect = screen.getByLabelText("Provider") as HTMLSelectElement;
    const modeSelect = screen.getByLabelText("Mode") as HTMLSelectElement;
    expect(screen.queryByText(/claude may modify files/i)).toBeNull();

    fireEvent.change(providerSelect, { target: { value: "claude-cli" } });
    fireEvent.change(modeSelect, { target: { value: "IMPLEMENT" } });
    expect(screen.getByText("Claude may modify files in the registered repository.")).toBeTruthy();

    fireEvent.change(modeSelect, { target: { value: "ASK" } });
    expect(screen.queryByText(/claude may modify files/i)).toBeNull();

    fireEvent.change(providerSelect, { target: { value: "codex-cli" } });
    fireEvent.change(modeSelect, { target: { value: "IMPLEMENT" } });
    expect(screen.queryByText(/claude may modify files/i)).toBeNull();
  });

  it("keeps Send enabled for every explicit provider/mode pair, since all are now capability-supported", () => {
    render(<ConversationChat {...baseProps()} />);
    const providerSelect = screen.getByLabelText("Provider") as HTMLSelectElement;
    const modeSelect = screen.getByLabelText("Mode") as HTMLSelectElement;
    const sendButton = screen.getByRole("button", { name: /send/i }) as HTMLButtonElement;
    for (const providerId of ["codex-cli", "claude-cli"]) {
      fireEvent.change(providerSelect, { target: { value: providerId } });
      for (const mode of ["ASK", "IMPLEMENT", "REVIEW", "CONTINUE", "VERIFY"]) {
        fireEvent.change(modeSelect, { target: { value: mode } });
        expect(sendButton.disabled).toBe(false);
      }
    }
  });

  it("stops polling once the execution reaches a terminal state", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ status: "SUCCEEDED", selectedProvider: "codex-cli", providerSession: null, events: [], assistantMessage: null, error: null }) }));
    vi.stubGlobal("fetch", fetchMock);
    render(<ConversationChat {...baseProps({ initialActiveExecutionId: "exec-1" })} />);
    await vi.advanceTimersByTimeAsync(5_000);
    const callsAfterSettling = fetchMock.mock.calls.length;
    expect(callsAfterSettling).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock.mock.calls.length).toBe(callsAfterSettling);
  });

  describe("model selection", () => {
    const CLAUDE_MODELS = [
      { modelId: "sonnet", displayName: "Claude Sonnet", enabled: true, allowedReasoningEfforts: [], validation: { status: "AVAILABLE", reason: null, checkedAt: null } },
      { modelId: "opus", displayName: "Claude Opus", enabled: true, allowedReasoningEfforts: [], validation: { status: "AVAILABLE", reason: null, checkedAt: null } },
      { modelId: "claude-legacy", displayName: "Claude Legacy", enabled: true, allowedReasoningEfforts: [], validation: { status: "UNSUPPORTED", reason: "model not found", checkedAt: null } },
    ];
    const CODEX_MODELS = [
      { modelId: "o3", displayName: "Codex o3", enabled: true, allowedReasoningEfforts: ["low", "medium", "high"], validation: { status: "UNKNOWN", reason: null, checkedAt: null } },
    ];

    function mockModelsFetch() {
      vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/providers/claude-cli/models")) return { ok: true, json: async () => ({ providerId: "claude-cli", models: CLAUDE_MODELS }) };
        if (url.includes("/api/providers/codex-cli/models")) return { ok: true, json: async () => ({ providerId: "codex-cli", models: CODEX_MODELS }) };
        return { ok: true, json: async () => ({ status: "QUEUED", selectedProvider: "codex-cli", providerSession: null, events: [], assistantMessage: null, error: null }) };
      }));
    }

    it("refreshes the available model options when the provider changes, and Default is always the first option", async () => {
      mockModelsFetch();
      render(<ConversationChat {...baseProps()} />);
      const providerSelect = screen.getByLabelText("Provider") as HTMLSelectElement;
      const modelSelect = screen.getByLabelText("Model") as HTMLSelectElement;
      expect(modelSelect.options[0]!.value).toBe("");
      expect(modelSelect.options[0]!.textContent).toBe("Default");
      expect(modelSelect.options).toHaveLength(1);

      fireEvent.change(providerSelect, { target: { value: "claude-cli" } });
      await waitFor(() => expect(modelSelect.options).toHaveLength(1 + CLAUDE_MODELS.length));
      expect(Array.from(modelSelect.options).map(o => o.value)).toEqual(expect.arrayContaining(["sonnet", "opus", "claude-legacy"]));

      fireEvent.change(providerSelect, { target: { value: "codex-cli" } });
      await waitFor(() => expect(modelSelect.options).toHaveLength(1 + CODEX_MODELS.length));
      expect(modelSelect.value).toBe(""); // reset to Default on provider change
    });

    it("disables a model whose validation actively reports it unavailable, with a visible reason, but never disables Default", async () => {
      mockModelsFetch();
      render(<ConversationChat {...baseProps()} />);
      fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "claude-cli" } });
      const modelSelect = screen.getByLabelText("Model") as HTMLSelectElement;
      await waitFor(() => expect(modelSelect.options).toHaveLength(1 + CLAUDE_MODELS.length));

      const defaultOption = Array.from(modelSelect.options).find(o => o.value === "")!;
      const sonnetOption = Array.from(modelSelect.options).find(o => o.value === "sonnet")!;
      const legacyOption = Array.from(modelSelect.options).find(o => o.value === "claude-legacy")!;
      expect(defaultOption.disabled).toBe(false);
      expect(sonnetOption.disabled).toBe(false);
      expect(legacyOption.disabled).toBe(true);
      expect(legacyOption.textContent).toMatch(/unavailable/i);
      expect(legacyOption.textContent).toMatch(/model not found/i);
    });

    it("shows the reasoning effort selector only for a model that supports it", async () => {
      mockModelsFetch();
      render(<ConversationChat {...baseProps()} />);
      fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "claude-cli" } });
      const modelSelect = screen.getByLabelText("Model") as HTMLSelectElement;
      await waitFor(() => expect(modelSelect.options).toHaveLength(1 + CLAUDE_MODELS.length));

      fireEvent.change(modelSelect, { target: { value: "sonnet" } });
      expect(screen.queryByLabelText("Reasoning effort")).toBeNull();

      fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "codex-cli" } });
      await waitFor(() => expect((screen.getByLabelText("Model") as HTMLSelectElement).options).toHaveLength(1 + CODEX_MODELS.length));
      fireEvent.change(screen.getByLabelText("Model"), { target: { value: "o3" } });
      expect(screen.getByLabelText("Reasoning effort")).toBeTruthy();
      const effortSelect = screen.getByLabelText("Reasoning effort") as HTMLSelectElement;
      expect(Array.from(effortSelect.options).map(o => o.value)).toEqual(expect.arrayContaining(["low", "medium", "high"]));
    });

    it("shows the model name in the workspace-write safety label (e.g. \"Claude Opus may modify files...\")", async () => {
      mockModelsFetch();
      render(<ConversationChat {...baseProps()} />);
      fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "claude-cli" } });
      fireEvent.change(screen.getByLabelText("Mode"), { target: { value: "IMPLEMENT" } });
      const modelSelect = screen.getByLabelText("Model") as HTMLSelectElement;
      await waitFor(() => expect(modelSelect.options).toHaveLength(1 + CLAUDE_MODELS.length));

      expect(screen.getByText("Claude may modify files in the registered repository.")).toBeTruthy();

      fireEvent.change(modelSelect, { target: { value: "opus" } });
      expect(screen.getByText("Claude Opus may modify files in the registered repository.")).toBeTruthy();
    });

    it("warns that changing the model starts a new provider session when a prior session is pinned to a different model", async () => {
      mockModelsFetch();
      render(<ConversationChat {...baseProps({ providerSessions: [{ id: "ps-1", providerId: "claude-cli", status: "RUNNING", resolvedModel: "sonnet" }] })} />);
      fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "claude-cli" } });
      const modelSelect = screen.getByLabelText("Model") as HTMLSelectElement;
      await waitFor(() => expect(modelSelect.options).toHaveLength(1 + CLAUDE_MODELS.length));

      // Still Default (no explicit model) - differs from the pinned "sonnet", so switching now would already start a new session.
      expect(screen.getByText(/will start a new claude provider session/i)).toBeTruthy();

      fireEvent.change(modelSelect, { target: { value: "sonnet" } });
      expect(screen.queryByText(/will start a new claude provider session/i)).toBeNull();

      fireEvent.change(modelSelect, { target: { value: "opus" } });
      expect(screen.getByText(/will start a new claude provider session/i)).toBeTruthy();
    });

    it("displays the requested/resolved model on an assistant message", () => {
      render(
        <ConversationChat
          {...baseProps({
            messages: [
              makeMessage({ id: "a1", role: "ASSISTANT", providerId: "claude-cli", content: "reply", requestedModel: "opus", resolvedModel: "claude-opus-4-8" }),
            ],
          })}
        />
      );
      expect(screen.getByText("claude-opus-4-8")).toBeTruthy();
    });

    it("shows CLI version separately from model on the provider status panel", () => {
      render(<ConversationChat {...baseProps()} />);
      expect(screen.getByText(/CLI version: codex 1.0/)).toBeTruthy();
      expect(screen.getByText(/CLI version: claude 2.0/)).toBeTruthy();
    });
  });
});
