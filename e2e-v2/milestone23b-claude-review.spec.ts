import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";

async function createProject(page: Page, name: string): Promise<void> {
  const dataDir = path.resolve(process.env.RELAY_V2_E2E_DATA_DIR ?? "");
  const workspace = path.join(dataDir, `workspace-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`);
  await mkdir(path.join(workspace, ".git"), { recursive: true });
  execFileSync("git", ["init", workspace], { stdio: "ignore" });
  execFileSync("git", ["-C", workspace, "config", "user.email", "relay-browser@example.invalid"], { stdio: "ignore" });
  execFileSync("git", ["-C", workspace, "config", "user.name", "Relay Browser Test"], { stdio: "ignore" });
  await writeFile(path.join(workspace, "README.md"), "# Disposable browser workspace\n");
  execFileSync("git", ["-C", workspace, "add", "README.md"], { stdio: "ignore" });
  execFileSync("git", ["-C", workspace, "commit", "-m", "baseline"], { stdio: "ignore" });
  await page.goto("/v2/projects/new");
  await page.getByLabel("Project name").fill(name);
  await page.getByLabel("Absolute Git repository path").fill(workspace);
  const submit = page.getByRole("button", { name: "Create project" });
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(page).toHaveURL(/\/v2\/projects$/);
  await expect(page.getByRole("heading", { name })).toBeVisible();
}

/**
 * Runs a Codex test-double execution to SUCCEEDED for a task approved with
 * reviewer selection CLAUDE, embedding a `RELAY_TEST_DOUBLE_SCENARIO: <...>`
 * marker in the objective -- the only field of the review material that ends
 * up in the Claude test-double's rendered stdin (its config is entirely
 * server-derived; there is no client-supplied reviewerConfig for claude-cli,
 * unlike FakeReviewer's UI dropdown), so this is how the browser test
 * controls which scenario `BrowserClaudeProcessDouble` runs.
 */
async function runCodexTestDoubleToSuccess(page: Page, projectName: string, title: string, claudeScenario: string): Promise<void> {
  await page.goto("/v2/tasks/new");
  await page.getByLabel("Project").selectOption({ label: projectName });
  await page.getByLabel("Title").fill(title);
  await page.getByLabel("Objective").fill(`Exercise the Milestone 2.3B authoritative Claude review workflow. RELAY_TEST_DOUBLE_SCENARIO: ${claudeScenario}`);
  await page.getByLabel("Acceptance criteria, one per line").fill("Execution succeeds\nAn authoritative Claude review can be requested");
  await page.getByLabel("Executor").selectOption("codex");
  await page.getByLabel("Reviewer").selectOption("claude");
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
}

test("requests an authoritative Claude review (test-double) and displays an APPROVE verdict with material/prompt hashes, never a commit", async ({ page }) => {
  await createProject(page, "Claude Review Browser Project");
  await runCodexTestDoubleToSuccess(page, "Claude Review Browser Project", "Claude approve flow", "approve");

  await expect(page.getByRole("heading", { name: "Review Gate", exact: true })).toBeVisible();
  const claudeButton = page.getByRole("button", { name: "Request Claude Review (authoritative)" });
  await expect(claudeButton).toBeVisible();
  await claudeButton.click();
  await expect(page).toHaveURL(/\/v2\/reviews\/[0-9a-f-]+/);

  // AUTHORITATIVE, not DIAGNOSTIC -- and never rendered with the diagnostic-only label.
  await expect(page.getByText("AUTHORITATIVE", { exact: true }).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Diagnostic approval", { exact: true })).toHaveCount(0);
  await expect(page.getByText("APPROVED", { exact: true }).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("heading", { name: "Structured Verdict: APPROVE", exact: true })).toBeVisible();

  // The invocation card proves the test-double actually ran through
  // ClaudeCliReviewer's real capability/materialization/prompt/wrapper-parsing
  // code path (only the process itself is doubled): a version string, a
  // terminal invocation status, and both bound hashes.
  await expect(page.getByText(/reviewer: claude-cli.*test-double/i)).toBeVisible();
  await expect(page.getByText(/invocation status/i)).toBeVisible();
  await expect(page.getByText(/material hash:/i)).toBeVisible();
  await expect(page.getByText(/prompt hash:/i)).toBeVisible();

  await expect(page.getByText("A review approval never commits, merges, or auto-accepts", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: /commit|push|merge|retry|deploy/i })).toHaveCount(0);
});

test("requests an authoritative Claude review (test-double) that REJECTs with a blocking finding", async ({ page }) => {
  await createProject(page, "Claude Review Reject Browser Project");
  await runCodexTestDoubleToSuccess(page, "Claude Review Reject Browser Project", "Claude reject flow", "reject");

  await page.getByRole("button", { name: "Request Claude Review (authoritative)" }).click();
  await expect(page).toHaveURL(/\/v2\/reviews\/[0-9a-f-]+/);

  await expect(page.getByText("AUTHORITATIVE", { exact: true }).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("REJECTED", { exact: true }).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("heading", { name: "Structured Verdict: REJECT", exact: true })).toBeVisible();
  await expect(page.getByText("BLOCKER", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Test double rejection", { exact: false })).toBeVisible();
});

test("cancels a running authoritative Claude review (test-double) from the browser", async ({ page }) => {
  await createProject(page, "Claude Review Cancel Browser Project");
  await runCodexTestDoubleToSuccess(page, "Claude Review Cancel Browser Project", "Claude cancellation flow", "cancellation");

  await page.getByRole("button", { name: "Request Claude Review (authoritative)" }).click();
  await expect(page).toHaveURL(/\/v2\/reviews\/[0-9a-f-]+/);
  await expect(page.getByRole("button", { name: "Cancel Review" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel Review" }).click();
  await expect(page.getByText("CANCELLED", { exact: true }).first()).toBeVisible({ timeout: 15_000 });
});
