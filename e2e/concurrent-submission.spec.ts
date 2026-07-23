import { prisma } from "@project-relay/database";
import { expect, test } from "@playwright/test";
import { cleanupProject, createConversation, createProject } from "./seed.js";

const COMPOSER_PLACEHOLDER = /ask, implement, review/i;
const SEND_BUTTON = /^send$/i;

test("two-tab duplicate submission protection: concurrent submissions from two browser tabs do not corrupt conversation state", async ({ browser }) => {
  const project = await createProject();
  const conversation = await createConversation(project.id, "Two tab submission");

  const context1 = await browser.newContext();
  const context2 = await browser.newContext();
  try {
    const page1 = await context1.newPage();
    const page2 = await context2.newPage();

    await page1.goto(`/projects/${project.id}/conversations/${conversation.id}`);
    await page2.goto(`/projects/${project.id}/conversations/${conversation.id}`);

    await page1.getByPlaceholder(COMPOSER_PLACEHOLDER).fill("message from tab one");
    await page2.getByPlaceholder(COMPOSER_PLACEHOLDER).fill("message from tab two");

    await Promise.all([page1.getByRole("button", { name: SEND_BUTTON }).click(), page2.getByRole("button", { name: SEND_BUTTON }).click()]);

    await expect(page1.getByText("Awaiting response…")).toBeVisible();
    await expect(page2.getByText("Awaiting response…")).toBeVisible();

    const messages = await prisma.conversationMessage.findMany({ where: { conversationId: conversation.id, role: "USER" } });
    expect(messages).toHaveLength(2);
    expect(new Set(messages.map(m => m.content))).toEqual(new Set(["message from tab one", "message from tab two"]));

    const refreshedConversation = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
    expect(refreshedConversation.sequence).toBe(2);

    const sessions = await prisma.agentSession.findMany({ where: { conversationId: conversation.id } });
    expect(sessions).toHaveLength(2);
    expect(new Set(sessions.map(s => s.id)).size).toBe(2);
  } finally {
    await context1.close();
    await context2.close();
    await cleanupProject(project.id);
  }
});
