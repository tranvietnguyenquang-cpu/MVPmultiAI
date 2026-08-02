import path from "node:path";
import { mkdir } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

async function createProject(page: Page, name: string): Promise<void> {
  const dataDir = path.resolve(process.env.RELAY_V2_E2E_DATA_DIR ?? "");
  const workspace = path.join(dataDir, `workspace-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`);
  await mkdir(path.join(workspace, ".git"), { recursive: true });
  await page.goto("/v2/projects/new");
  await page.getByLabel("Project name").fill(name);
  await page.getByLabel("Absolute Git repository path").fill(workspace);
  const submit = page.getByRole("button", { name: "Create project" });
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(page).toHaveURL(/\/v2\/projects$/);
  await expect(page.getByRole("heading", { name })).toBeVisible();
}

test("creates, previews, and approves a task without execution", async ({ page }) => {
  await createProject(page, "Browser Test Project");

  await page.goto("/v2/tasks/new");
  await page.getByLabel("Project").selectOption({ label: "Browser Test Project" });
  await page.getByLabel("Title").fill("Verify pending workflow");
  await page.getByLabel("Objective").fill("Prove Milestone 1 cannot start execution.");
  await page.getByLabel("Acceptance criteria, one per line").fill("Task is pending before approval\nApproval does not execute");
  await page.getByRole("button", { name: "Create pending task" }).click();
  await expect(page).toHaveURL(/\/v2\/tasks\/[0-9a-f-]+$/);
  await expect(page.getByText("PENDING_APPROVAL", { exact: true }).first()).toBeVisible();

  await page.getByRole("link", { name: "Open approval view" }).click();
  await expect(page.getByText("Milestone 1 has no execution queue")).toBeVisible();
  await page.getByRole("button", { name: "Approve without executing" }).click();
  await expect(page.getByText("APPROVED", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("No code, queue job, provider session, Git mutation, or process is created")).toBeVisible();
});

test("validates and previews pasted YAML before creating a pending task", async ({ page }) => {
  await createProject(page, "YAML Browser Project");
  await page.goto("/v2/import");
  await page.getByLabel("Target project").selectOption({ label: "YAML Browser Project" });
  await page.getByLabel("YAML or JSON").fill(`version: 1
project:
  name: YAML Browser Project
task:
  title: Imported task
  objective: Validate a safe YAML handoff.
  taskType: analysis
  complexity: normal
acceptanceCriteria:
  - Preview is displayed
execution:
  requireApproval: true
`);
  await page.getByRole("button", { name: "Validate and preview" }).click();
  await expect(page.getByText("VALID YAML")).toBeVisible();
  await page.getByRole("button", { name: "Create PENDING_APPROVAL task" }).click();
  await expect(page).toHaveURL(/\/v2\/tasks\/[0-9a-f-]+$/);
  await expect(page.getByText("PENDING_APPROVAL", { exact: true }).first()).toBeVisible();
});
