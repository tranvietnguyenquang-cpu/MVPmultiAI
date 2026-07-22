// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: pushMock, refresh: vi.fn() }) }));

const csrfFetchMock = vi.fn();
vi.mock("../lib/csrf-client", () => ({ csrfFetch: (...args: unknown[]) => csrfFetchMock(...args) }));

import { ConversationForm } from "./conversation-form.js";

describe("ConversationForm", () => {
  beforeEach(() => {
    pushMock.mockReset();
    csrfFetchMock.mockReset();
  });

  afterEach(() => cleanup());

  it("creates a conversation and navigates to its detail page", async () => {
    csrfFetchMock.mockResolvedValue({ ok: true, json: async () => ({ id: "conversation-123" }) });
    render(<ConversationForm projectId="project-1" />);
    fireEvent.change(screen.getByLabelText("Conversation title"), { target: { value: "New chat" } });
    fireEvent.click(screen.getByRole("button", { name: /start conversation/i }));
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/projects/project-1/conversations/conversation-123"));
    expect(csrfFetchMock).toHaveBeenCalledWith("/api/projects/project-1/conversations", expect.objectContaining({ method: "POST" }));
  });
});
