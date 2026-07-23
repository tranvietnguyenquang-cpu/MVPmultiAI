import { expect, test } from "@playwright/test";
import { cleanupProject, createConversation, createProject, seedTurn } from "./seed.js";

test("Codex -> Claude -> Codex provider attribution renders correctly across a handoff sequence", async ({ page }) => {
  const project = await createProject();
  const conversation = await createConversation(project.id, "Provider attribution");

  await seedTurn({ conversationId: conversation.id, role: "USER", content: "please implement the widget" });
  await seedTurn({ conversationId: conversation.id, role: "ASSISTANT", providerId: "codex-cli", content: "Implemented the widget in Codex." });
  await seedTurn({ conversationId: conversation.id, role: "USER", content: "please review it" });
  await seedTurn({ conversationId: conversation.id, role: "ASSISTANT", providerId: "claude-cli", content: "Reviewed: looks solid, one nit." });
  await seedTurn({ conversationId: conversation.id, role: "USER", content: "please fix the nit" });
  await seedTurn({ conversationId: conversation.id, role: "ASSISTANT", providerId: "codex-cli", content: "Fixed the nit." });

  try {
    await page.goto(`/projects/${project.id}/conversations/${conversation.id}`);

    const badges = page.locator(".badge");
    await expect(badges).toHaveCount(3);
    await expect(badges.nth(0)).toHaveText("Codex");
    await expect(badges.nth(1)).toHaveText("Claude");
    await expect(badges.nth(2)).toHaveText("Codex");

    // Attribution must track content, not just position: each badge sits with its own reply.
    await expect(page.getByText("Implemented the widget in Codex.")).toBeVisible();
    await expect(page.getByText("Reviewed: looks solid, one nit.")).toBeVisible();
    await expect(page.getByText("Fixed the nit.")).toBeVisible();
  } finally {
    await cleanupProject(project.id);
  }
});
