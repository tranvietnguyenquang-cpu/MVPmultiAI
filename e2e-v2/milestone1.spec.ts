import path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

async function createProject(page: Page, name: string, realGit = false): Promise<void> {
  const dataDir = path.resolve(process.env.RELAY_V2_E2E_DATA_DIR ?? "");
  const workspace = path.join(dataDir, `workspace-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`);
  await mkdir(path.join(workspace, ".git"), { recursive: true });
  if (realGit) {
    execFileSync("git", ["init", workspace], { stdio: "ignore" });
    execFileSync("git", ["-C", workspace, "config", "user.email", "relay-browser@example.invalid"], { stdio: "ignore" });
    execFileSync("git", ["-C", workspace, "config", "user.name", "Relay Browser Test"], { stdio: "ignore" });
    await writeFile(path.join(workspace, "README.md"), "# Disposable browser workspace\n");
    execFileSync("git", ["-C", workspace, "add", "README.md"], { stdio: "ignore" });
    execFileSync("git", ["-C", workspace, "commit", "-m", "baseline"], { stdio: "ignore" });
  }
  await page.goto("/v2/projects/new");
  await page.getByLabel("Project name").fill(name);
  await page.getByLabel("Absolute Git repository path").fill(workspace);
  const submit = page.getByRole("button", { name: "Create project" });
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(page).toHaveURL(/\/v2\/projects$/);
  await expect(page.getByRole("heading", { name })).toBeVisible();
}

test("approves a task, requests FakeExecutor execution, and observes persisted success events", async ({ page }) => {
  await createProject(page, "Browser Test Project");

  await page.goto("/v2/tasks/new");
  await page.getByLabel("Project").selectOption({ label: "Browser Test Project" });
  await page.getByLabel("Title").fill("Verify pending workflow");
  await page.getByLabel("Objective").fill("Prove approved work runs only through FakeExecutor.");
  await page.getByLabel("Acceptance criteria, one per line").fill("Task is pending before approval\nApproval does not execute");
  await page.getByRole("button", { name: "Create pending task" }).click();
  await expect(page).toHaveURL(/\/v2\/tasks\/[0-9a-f-]+$/);
  const taskUrl = page.url();
  await expect(page.getByText("PENDING_APPROVAL", { exact: true }).first()).toBeVisible();

  await page.getByRole("link", { name: "Open approval view" }).click();
  await expect(page.getByText("Approval itself stops at APPROVED", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Approve without executing" }).click();
  await expect(page.getByText("APPROVED", { exact: true }).first()).toBeVisible();
  await page.goto(taskUrl);
  await page.getByLabel("Fake executor scenario").selectOption("success");
  await page.getByRole("button", { name: "Request Fake Execution" }).click();
  await expect(page).toHaveURL(/\/v2\/executions\/[0-9a-f-]+/);
  await expect(page.getByText("SUCCEEDED", { exact: true }).first()).toBeVisible();
  await expect(page.getByLabel("Execution live logs").getByText("Fake output 1", { exact: true })).toBeVisible();
  await expect(page.getByText("LOG", { exact: true })).toBeVisible();
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
  await expect(page.getByRole("button", { name: "Request Execution" })).toHaveCount(0);
});

test("cancels a running FakeExecutor session and releases its workspace lease", async ({ page }) => {
  await createProject(page, "Cancellation Browser Project");
  await page.goto("/v2/tasks/new");
  await page.getByLabel("Project").selectOption({ label: "Cancellation Browser Project" });
  await page.getByLabel("Title").fill("Cancel fake execution");
  await page.getByLabel("Objective").fill("Verify in-process cancellation reaches a durable terminal state.");
  await page.getByLabel("Acceptance criteria, one per line").fill("Execution is cancelled\nWorkspace lease is released");
  await page.getByRole("button", { name: "Create pending task" }).click();
  await expect(page).toHaveURL(/\/v2\/tasks\/[0-9a-f-]+$/);
  const taskUrl = page.url();
  await page.getByRole("link", { name: "Open approval view" }).click();
  await page.getByRole("button", { name: "Approve without executing" }).click();
  await expect(page.getByText("APPROVED", { exact: true }).first()).toBeVisible();
  await page.goto(taskUrl);
  await page.getByLabel("Fake executor scenario").selectOption("cancellation");
  await page.getByRole("button", { name: "Request Fake Execution" }).click();
  await expect(page.getByRole("button", { name: "Cancel Execution" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel Execution" }).click();
  await expect(page.getByText("CANCELLED", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("RELEASED", { exact: true })).toBeVisible();
});

test("runs an approved Codex execution through the in-process browser test double", async ({ page }) => {
  await createProject(page, "Codex Browser Project", true);
  await page.goto("/v2/tasks/new");
  await page.getByLabel("Project").selectOption({ label: "Codex Browser Project" });
  await page.getByLabel("Title").fill("Codex test-double execution");
  await page.getByLabel("Objective").fill("Exercise the Codex executor UI without invoking real Codex.");
  await page.getByLabel("Acceptance criteria, one per line").fill("Capsule is shown\nGit evidence is shown\nNo commit control exists");
  await page.getByLabel("Executor").selectOption("codex");
  await page.getByLabel("Allow workspace writes (required for Codex)").check();
  await page.getByLabel("Confirm this is a non-production target").check();
  await page.getByRole("button", { name: "Create pending task" }).click();
  await expect(page).toHaveURL(/\/v2\/tasks\/[0-9a-f-]+$/);
  const taskUrl = page.url();
  await page.getByRole("link", { name: "Open approval view" }).click();
  await page.getByRole("button", { name: "Approve without executing" }).click();
  await expect(page.getByText("APPROVED", { exact: true }).first()).toBeVisible();
  await page.goto(taskUrl);
  await page.getByRole("button", { name: "Inspect Git baseline" }).click();
  await expect(page.getByText("CLEAN", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Request Codex Execution" }).click();
  await expect(page).toHaveURL(/\/v2\/executions\/[0-9a-f-]+/);
  await expect(page.getByText("SUCCEEDED", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Immutable Execution Capsule")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Post-run Git Evidence", exact: true })).toBeVisible();
  await expect(page.getByLabel("Execution live logs").getByText("Codex test double received the immutable capsule.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /commit|push|merge/i })).toHaveCount(0);
});

test("shows Codex diagnostics without exposing credential contents", async ({ page }) => {
  await page.goto("/v2/executors/codex");
  await expect(page.getByRole("heading", { name: "Codex CLI", exact: true })).toBeVisible();
  await expect(page.getByText("No persisted capability snapshot", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Test connection" }).click();
  await expect(page.getByText("Authentication: AUTHENTICATED")).toBeVisible();
  await expect(page.getByText("Path: Playwright test double")).toBeVisible();
});
