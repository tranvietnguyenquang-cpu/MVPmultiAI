import { describe, expect, it } from "vitest";
import { parseHandoffText, untruncatedProvenance } from "@project-relay/relay-v2-domain";
import { buildExecutionCapsule, renderCodexPrompt } from "./execution-capsule.js";
import type { GitEvidence } from "./workspace-evidence.js";

describe("execution capsule", () => {
  it("is deterministic for an exact approved snapshot and excludes secrets", () => {
    const spec = parseHandoffText(JSON.stringify({
      version: 1, project: { name: "Capsule" },
      task: { title: "Implement capsule", objective: "Use the approved capsule", taskType: "implementation", complexity: "normal" },
      acceptanceCriteria: ["Capsule is hashed"],
      execution: { executor: "codex", model: "auto", effort: "auto", reviewer: "none", requireApproval: true, workspaceWrite: true, nonProductionConfirmed: true }
    })).normalized;
    const baseline = {
      repositoryRoot: "C:\\workspace", branch: "relay-v2", head: "a".repeat(40), dirty: false, status: [], stagedCount: 0,
      unstagedCount: 0, untrackedCount: 0, patchPreview: "", patchSha256: "b".repeat(64), patchTruncated: false, patchProvenance: untruncatedProvenance(""),
      patchOmittedForSensitivePaths: false, capturedAt: "2026-08-02T00:00:00.000Z", evidenceHash: "c".repeat(64)
    } satisfies GitEvidence;
    const input = {
      sessionId: "11111111-1111-4111-8111-111111111111", taskId: "22222222-2222-4222-8222-222222222222",
      projectId: "33333333-3333-4333-8333-333333333333", spec, permissions: spec.permissions,
      workspacePath: "C:\\workspace", baseline, timeoutSeconds: 1800, verificationOperations: ["NPM_TEST" as const],
      artifactDirectory: "executions/session", createdAt: new Date("2026-08-02T00:00:00.000Z")
    };
    const first = buildExecutionCapsule(input);
    const second = buildExecutionCapsule(input);
    expect(first.capsuleHash).toBe(second.capsuleHash);
    expect(first.capsuleHash).toMatch(/^[a-f0-9]{64}$/);
    const prompt = renderCodexPrompt(first);
    expect(prompt).toContain("Do not access production");
    expect(prompt).not.toContain(".env contents");
  });
});
