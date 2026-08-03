import { access, realpath } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { CodexCapabilitySnapshot } from "./codex-capabilities.js";
import { prepareDisposableGitWorkspace, runDisposableReadOnlyCodexSmoke } from "./disposable-codex-smoke.js";
import type { ProcessRunner } from "./process-runner.js";
import { WorkspaceEvidenceService } from "./workspace-evidence.js";

const snapshot: CodexCapabilitySnapshot = {
  executorId: "codex-cli", executablePath: process.execPath, displayPath: "node", version: "fixture",
  detectedAt: new Date().toISOString(), execAvailable: true, modelFlag: true,
  reasoningEffortMechanism: "UNKNOWN", sandboxModes: ["read-only", "workspace-write"], approvalModes: ["never"],
  outputModes: ["jsonl"], workingDirectorySupport: true, timeoutManagedByRelay: true, cancellationManagedByRelay: true,
  authenticationStatus: "UNKNOWN", rawHelpHash: "a".repeat(64), supported: true, unsupportedReasons: []
};

describe("disposable Codex smoke workspace", () => {
  it("creates a committed clean Git repository and removes it during cleanup", async () => {
    const prepared = await prepareDisposableGitWorkspace();
    const workspace = prepared.workspacePath;
    await access(`${workspace}\\.git`);
    const evidence = await new WorkspaceEvidenceService().capture(workspace);
    expect(await realpath(evidence.repositoryRoot)).toBe(await realpath(workspace));
    expect(evidence.head).toMatch(/^[a-f0-9]{40,64}$/i);
    expect(evidence.dirty).toBe(false);
    await prepared.cleanup();
    await expect(access(workspace)).rejects.toThrow();
    await prepared.cleanup();
  });

  it("never invokes Codex before disposable repository validation succeeds", async () => {
    const run = vi.fn(async function* () { yield { type: "exit", result: {} }; });
    const runner = { run, cancel: vi.fn(), owns: vi.fn() } as unknown as ProcessRunner;
    await expect(runDisposableReadOnlyCodexSmoke(snapshot, {
      codexRunner: runner,
      prepareWorkspace: async () => { throw new Error("repository validation failed"); }
    })).rejects.toThrow(/repository validation failed/);
    expect(run).not.toHaveBeenCalled();
  });
});
