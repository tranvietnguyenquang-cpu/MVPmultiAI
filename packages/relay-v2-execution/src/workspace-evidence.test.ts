import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareDisposableGitWorkspace, type DisposableGitWorkspace } from "./disposable-codex-smoke.js";
import { compareGitEvidence, WorkspaceEvidenceService } from "./workspace-evidence.js";

describe("WorkspaceEvidenceService", () => {
  let prepared: DisposableGitWorkspace;
  let workspace: string;
  let git: string;
  let service: WorkspaceEvidenceService;

  async function runGit(args: string[]): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let stdout = "";
      const child = spawn(git, args, { cwd: workspace, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.on("data", chunk => { stdout += chunk.toString(); });
      child.once("error", reject);
      child.once("exit", code => code === 0 ? resolve(stdout.trim()) : reject(new Error(`git exited ${code}`)));
    });
  }

  beforeEach(async () => {
    prepared = await prepareDisposableGitWorkspace();
    workspace = prepared.workspacePath;
    service = new WorkspaceEvidenceService();
    git = (await service.findGitExecutable()) ?? "";
    if (!git) throw new Error("Git is required for workspace evidence tests.");
  });

  afterEach(async () => { await prepared?.cleanup(); });

  it("captures stable clean branch, HEAD, index, and stash evidence", async () => {
    const evidence = await service.capture(workspace);
    const repeated = await service.capture(workspace);
    expect(evidence.dirty).toBe(false);
    expect(evidence.head).toMatch(/^[a-f0-9]{40,64}$/);
    expect(evidence.indexIdentitySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.stashRef).toBeNull();
    expect(evidence.evidenceHash).toBe(repeated.evidenceHash);
  });

  it("distinguishes ordinary session-created changes from preserved pre-existing work", async () => {
    await writeFile(path.join(workspace, "README.md"), "pre-existing\n");
    const baseline = await service.capture(workspace);
    await writeFile(path.join(workspace, "executor-created.txt"), "new\n");
    const final = await service.capture(workspace, baseline.status.map(item => item.path));
    const delta = compareGitEvidence(baseline, final);
    expect(delta.changedFiles).toEqual([expect.objectContaining({ path: "executor-created.txt", preExisting: false })]);
    expect(delta.forbiddenGitMutationSuspected).toBe(false);
  });

  it("allows valid new changes from a clean baseline", async () => {
    const baseline = await service.capture(workspace);
    await writeFile(path.join(workspace, "created.txt"), "created during session\n");
    const delta = compareGitEvidence(baseline, await service.capture(workspace));
    expect(delta.changedFiles).toEqual([expect.objectContaining({ path: "created.txt", preExisting: false })]);
    expect(delta.forbiddenGitMutationSuspected).toBe(false);
  });

  it("detects checkout reverting a pre-existing modified file", async () => {
    await writeFile(path.join(workspace, "README.md"), "valuable user edit\n");
    const baseline = await service.capture(workspace);
    await runGit(["checkout", "--", "README.md"]);
    const delta = compareGitEvidence(baseline, await service.capture(workspace, ["README.md"]));
    expect(delta.preExistingChangesDestroyed).toContain("README.md");
    expect(delta.forbiddenGitMutationSuspected).toBe(true);
  });

  it("detects deletion or cleaning of a pre-existing untracked file", async () => {
    const target = path.join(workspace, "user-notes.txt");
    await writeFile(target, "valuable untracked work\n");
    const baseline = await service.capture(workspace);
    await rm(target);
    const delta = compareGitEvidence(baseline, await service.capture(workspace, ["user-notes.txt"]));
    expect(delta.preExistingChangesDestroyed).toContain("user-notes.txt");
  });

  it("detects removal of a pre-existing staged state", async () => {
    await writeFile(path.join(workspace, "README.md"), "staged user edit\n");
    await runGit(["add", "--", "README.md"]);
    const baseline = await service.capture(workspace);
    await runGit(["reset", "HEAD", "--", "README.md"]);
    const delta = compareGitEvidence(baseline, await service.capture(workspace, ["README.md"]));
    expect(delta.preExistingChangesHidden).toContain("README.md");
  });

  it("detects stash identity changes", async () => {
    await writeFile(path.join(workspace, "README.md"), "work to hide\n");
    const baseline = await service.capture(workspace);
    await runGit(["stash", "push", "-m", "test-only stash"]);
    const delta = compareGitEvidence(baseline, await service.capture(workspace, ["README.md"]));
    expect(delta.stashChanged).toBe(true);
    expect(delta.forbiddenGitMutationSuspected).toBe(true);
  });

  it("omits textual patches when a likely secret file is dirty", async () => {
    await writeFile(path.join(workspace, ".env"), "UNRECOGNIZED_SECRET_VALUE=do-not-persist\n");
    const evidence = await service.capture(workspace);
    expect(evidence.patchOmittedForSensitivePaths).toBe(true);
    expect(evidence.patchPreview).toBe("");
    expect(JSON.stringify(evidence)).not.toContain("do-not-persist");
  });

  it("retains path containment when nested directories exist", async () => {
    await mkdir(path.join(workspace, "nested"), { recursive: true });
    await writeFile(path.join(workspace, "nested", "file.txt"), "nested\n");
    const evidence = await service.capture(workspace);
    expect(evidence.status.some(item => item.path === "nested/file.txt")).toBe(true);
  });
});
