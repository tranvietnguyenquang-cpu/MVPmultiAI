import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
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

async function runCodexTestDoubleToSuccess(page: Page, projectName: string, title: string): Promise<void> {
  await page.goto("/v2/tasks/new");
  await page.getByLabel("Project").selectOption({ label: projectName });
  await page.getByLabel("Title").fill(title);
  await page.getByLabel("Objective").fill("Exercise the Milestone 2.3A review workflow against a completed Codex test-double execution.");
  await page.getByLabel("Acceptance criteria, one per line").fill("Execution succeeds\nA review can be requested");
  await page.getByLabel("Executor").selectOption("codex");
  // A reviewer selection of NONE can never authorize a review (reviewer-authority binding);
  // pick a concrete selection so the diagnostic FakeReviewer review-gate flow is reachable.
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

test("requests a FakeReviewer review of a completed Codex test-double execution and displays an APPROVE verdict", async ({ page }) => {
  await createProject(page, "Review Browser Project", true);
  await runCodexTestDoubleToSuccess(page, "Review Browser Project", "Review approve flow");

  await expect(page.getByRole("heading", { name: "Review Gate", exact: true })).toBeVisible();
  await expect(page.getByText("FakeReviewer is diagnostic-only", { exact: false })).toBeVisible();
  // This task's approved reviewer selection is CLAUDE (see runCodexTestDoubleToSuccess),
  // and Milestone 2.3B legitimately surfaces a real "Request Claude Review" action on the
  // execution page for exactly that case -- this replaces the Milestone 2.3A guard that no
  // Claude UI existed at all yet. Checked here, on the execution page, before navigating away
  // to the review detail page below (the button does not exist there). The test never clicks
  // it: it only exercises the FakeReviewer diagnostic scenario controls, so no real Claude CLI
  // invocation happens in this test.
  await expect(page.getByRole("button", { name: /request claude review/i })).toBeVisible();
  await page.getByLabel("Reviewer scenario").selectOption("approve");
  await page.getByRole("button", { name: "Request Review" }).click();
  await expect(page).toHaveURL(/\/v2\/reviews\/[0-9a-f-]+/);

  // A DIAGNOSTIC APPROVE must render as "Diagnostic approval", never plain "APPROVED" —
  // the review-gate projection is authority-preserving, so this label alone is proof.
  await expect(page.getByText("Diagnostic approval", { exact: true }).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("APPROVED", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Structured Verdict: APPROVE", exact: true })).toBeVisible();
  await expect(page.getByText("A review approval never commits, merges, or auto-accepts", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: /commit|push|merge|retry|deploy/i })).toHaveCount(0);
});

test("displays REJECT findings with blocking severity", async ({ page }) => {
  await createProject(page, "Review Reject Browser Project", true);
  await runCodexTestDoubleToSuccess(page, "Review Reject Browser Project", "Review reject flow");

  await page.getByLabel("Reviewer scenario").selectOption("reject");
  await page.getByRole("button", { name: "Request Review" }).click();
  await expect(page).toHaveURL(/\/v2\/reviews\/[0-9a-f-]+/);

  await expect(page.getByText("REJECTED", { exact: true }).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("heading", { name: "Structured Verdict: REJECT", exact: true })).toBeVisible();
  await expect(page.getByText("Fake rejection", { exact: false })).toBeVisible();
  await expect(page.getByText("BLOCKER", { exact: true }).first()).toBeVisible();
});

test("cancels a running review from the browser", async ({ page }) => {
  await createProject(page, "Review Cancel Browser Project", true);
  await runCodexTestDoubleToSuccess(page, "Review Cancel Browser Project", "Review cancellation flow");

  await page.getByLabel("Reviewer scenario").selectOption("cancellation");
  await page.getByRole("button", { name: "Request Review" }).click();
  await expect(page).toHaveURL(/\/v2\/reviews\/[0-9a-f-]+/);
  await expect(page.getByRole("button", { name: "Cancel Review" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel Review" }).click();
  await expect(page.getByText("CANCELLED", { exact: true }).first()).toBeVisible({ timeout: 15_000 });
});
