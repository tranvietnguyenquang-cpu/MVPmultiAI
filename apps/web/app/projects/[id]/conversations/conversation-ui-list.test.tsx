// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() })
}));

const findUniqueMock = vi.fn();
const listProjectConversationsMock = vi.fn();
vi.mock("@project-relay/database", () => ({
  prisma: { project: { findUnique: (...args: unknown[]) => findUniqueMock(...args) } },
  listProjectConversations: (...args: unknown[]) => listProjectConversationsMock(...args)
}));

import ConversationsPage from "./page.js";

describe("Conversations list page", () => {
  beforeEach(() => {
    findUniqueMock.mockReset();
    listProjectConversationsMock.mockReset();
  });

  afterEach(() => cleanup());

  it("loads and displays the project's conversations", async () => {
    findUniqueMock.mockResolvedValue({ id: "project-1", name: "Demo project" });
    listProjectConversationsMock.mockResolvedValue([
      { id: "c1", title: "First chat", status: "ACTIVE", updatedAt: new Date("2026-01-01T00:00:00Z") },
      { id: "c2", title: "Second chat", status: "ACTIVE", updatedAt: new Date("2026-01-02T00:00:00Z") }
    ]);

    const element = await ConversationsPage({ params: Promise.resolve({ id: "project-1" }) });
    render(element);

    expect(screen.getByText("First chat")).toBeTruthy();
    expect(screen.getByText("Second chat")).toBeTruthy();
  });
});
