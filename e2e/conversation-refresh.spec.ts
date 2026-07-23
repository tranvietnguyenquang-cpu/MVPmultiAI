import { expect, test } from "@playwright/test";
import { cleanupProject, createConversation, createProject, seedTurn } from "./seed.js";

test("refresh persistence: reloading the page shows the identical persisted transcript", async ({ page }) => {
  const project = await createProject();
  const conversation = await createConversation(project.id, "Refresh persistence");
  await seedTurn({ conversationId: conversation.id, role: "USER", content: "What does this project do?" });
  await seedTurn({ conversationId: conversation.id, role: "ASSISTANT", providerId: "codex-cli", content: "This project relays multi-provider AI conversations." });

  try {
    await page.goto(`/projects/${project.id}/conversations/${conversation.id}`);
    await expect(page.getByText("What does this project do?")).toBeVisible();
    await expect(page.getByText("This project relays multi-provider AI conversations.")).toBeVisible();

    await page.reload();

    await expect(page.getByText("What does this project do?")).toBeVisible();
    await expect(page.getByText("This project relays multi-provider AI conversations.")).toBeVisible();
  } finally {
    await cleanupProject(project.id);
  }
});
