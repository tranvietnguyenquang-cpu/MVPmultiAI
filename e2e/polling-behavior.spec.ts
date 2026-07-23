import { prisma } from "@project-relay/database";
import { expect, test } from "@playwright/test";
import { cleanupProject, createConversation, createProject, waitForAgentSession } from "./seed.js";

const COMPOSER_PLACEHOLDER = /ask, implement, review/i;
const SEND_BUTTON = /^send$/i;

test("terminal polling behavior and temporary stream replacement", async ({ page }) => {
  const project = await createProject();
  const conversation = await createConversation(project.id, "Terminal polling");

  try {
    await page.goto(`/projects/${project.id}/conversations/${conversation.id}`);
    await page.getByPlaceholder(COMPOSER_PLACEHOLDER).fill("please summarize the repo");
    await page.getByRole("button", { name: SEND_BUTTON }).click();

    await expect(page.getByText(/awaiting response/i)).toBeVisible();

    const agentSession = await waitForAgentSession(conversation.id);

    // While still in flight, the worker's live stream shows up as a temporary view.
    await prisma.agentEvent.create({ data: { sessionId: agentSession.id, type: "stdout", message: "Looking at the repository structure…" } });
    await expect(page.getByText("Looking at the repository structure…")).toBeVisible();

    // Once the worker completes, the client's poll must detect the terminal state and
    // replace the temporary stream view with the final persisted assistant message.
    await prisma.agentSession.update({ where: { id: agentSession.id }, data: { state: "SUCCEEDED", endedAt: new Date() } });
    await prisma.conversationMessage.create({
      data: { conversationId: conversation.id, role: "ASSISTANT", providerId: "codex-cli", mode: "ASK", content: "This repository implements ProjectRelay.", status: "COMPLETED", agentSessionId: agentSession.id }
    });

    await expect(page.getByText(/awaiting response/i)).toBeHidden({ timeout: 8_000 });
    await expect(page.getByText("This repository implements ProjectRelay.")).toBeVisible();
    await expect(page.getByText("Looking at the repository structure…")).toBeHidden();
  } finally {
    await cleanupProject(project.id);
  }
});

test("duplicate event handling: repeated polls of the same events never duplicate rendered output", async ({ page }) => {
  const project = await createProject();
  const conversation = await createConversation(project.id, "Duplicate events");

  try {
    await page.goto(`/projects/${project.id}/conversations/${conversation.id}`);
    await page.getByPlaceholder(COMPOSER_PLACEHOLDER).fill("hello");
    await page.getByRole("button", { name: SEND_BUTTON }).click();
    await expect(page.getByText(/awaiting response/i)).toBeVisible();

    const agentSession = await waitForAgentSession(conversation.id);
    await prisma.agentEvent.create({ data: { sessionId: agentSession.id, type: "stdout", message: "partial output chunk" } });
    await expect(page.getByText("partial output chunk")).toBeVisible();

    // The polled endpoint returns the full event list every tick (no cursor); the client
    // must not accumulate/duplicate it across ticks even though the same data repeats.
    await page.waitForTimeout(3_500);
    await expect(page.locator("text=partial output chunk")).toHaveCount(1);
  } finally {
    await cleanupProject(project.id);
  }
});

test("failure display: a failed execution surfaces the error to the user", async ({ page }) => {
  const project = await createProject();
  const conversation = await createConversation(project.id, "Failure display");

  try {
    await page.goto(`/projects/${project.id}/conversations/${conversation.id}`);
    await page.getByPlaceholder(COMPOSER_PLACEHOLDER).fill("do the impossible");
    await page.getByRole("button", { name: SEND_BUTTON }).click();
    await expect(page.getByText(/awaiting response/i)).toBeVisible();

    const agentSession = await waitForAgentSession(conversation.id);
    const errorMessage = "codex-cli is not authenticated. Install Codex CLI and authenticate with `codex login`.";
    await prisma.agentSession.update({ where: { id: agentSession.id }, data: { state: "FAILED", endedAt: new Date(), error: errorMessage } });
    await prisma.conversationMessage.create({
      data: { conversationId: conversation.id, role: "ASSISTANT", providerId: "codex-cli", mode: "ASK", content: errorMessage, status: "FAILED", agentSessionId: agentSession.id }
    });

    await expect(page.getByText(/awaiting response/i)).toBeHidden({ timeout: 8_000 });
    await expect(page.getByText("FAILED")).toBeVisible();
    await expect(page.getByText(errorMessage)).toBeVisible();
  } finally {
    await cleanupProject(project.id);
  }
});
