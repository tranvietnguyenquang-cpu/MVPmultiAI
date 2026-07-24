import { expect, test } from "@playwright/test";
import { prisma } from "@project-relay/database";
import { cleanupProject, e2eWorkspace } from "./seed.js";

const PORT = process.env.PROJECT_RELAY_E2E_PORT ?? "3300";

test("canonical origin: opening via 127.0.0.1 redirects to localhost before session bootstrap, repository registration succeeds, and a refresh preserves the session", async ({ page }) => {
  await page.goto(`http://127.0.0.1:${PORT}/`);

  // The redirect must have already happened before any client script could ever call the
  // session-bootstrap endpoint: by the time the page is interactive, its own origin is
  // already the canonical "localhost", never the 127.0.0.1 address it was opened at.
  expect(page.url()).toBe(`http://localhost:${PORT}/`);

  const projectName = `canonical-origin-${Date.now()}`;
  await page.getByLabel("Project name").fill(projectName);
  await page.getByLabel("Absolute repository path").fill(e2eWorkspace());
  await page.getByRole("button", { name: /register repository/i }).click();

  // A failed session bootstrap surfaces as "Could not establish a local session." here;
  // reaching the project page instead proves the whole redirect -> bootstrap -> CSRF ->
  // repository-registration chain worked end to end from the non-canonical entry URL.
  await page.waitForURL(/\/projects\/[^/]+$/);
  const projectId = page.url().split("/projects/")[1]?.split(/[/?]/)[0];
  expect(projectId).toBeTruthy();

  try {
    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId! } });
    expect(project.name).toBe(projectName);
    expect(project.repositoryPath).toBe(e2eWorkspace());

    // Refresh must preserve the session: reload the page, then perform another mutating,
    // session-gated request (creating a conversation, which requires requireLocalSession)
    // without ever re-bootstrapping - proving the cookie survived the reload rather than
    // merely proving the page can render.
    await page.reload();
    expect(page.url()).toBe(`http://localhost:${PORT}/projects/${projectId}`);
    await page.goto(`/projects/${projectId}/conversations`);
    await page.locator('input[name="title"]').fill("Post-refresh conversation");
    await page.getByRole("button", { name: /start conversation/i }).click();
    await page.waitForURL(/\/conversations\/[^/]+$/);

    const conversation = await prisma.conversation.findFirstOrThrow({ where: { projectId: projectId!, title: "Post-refresh conversation" } });
    expect(conversation.id).toBeTruthy();
  } finally {
    await cleanupProject(projectId!);
  }
});
