import { describe, expect, it } from "vitest";
import type { FakeReviewerScenario } from "@project-relay/relay-v2-domain";
import { FakeReviewer } from "./fake-reviewer.js";
import { computeRequestHash, computeReviewInputHash, type ReviewInputCapsule } from "./review-binding.js";
import type { ImmutableReviewCapsule, ReviewControls } from "./reviewer-contract.js";

const HASH = "a".repeat(64);

function baseCapsule(): ReviewInputCapsule {
  return {
    reviewRequestId: "00000000-0000-4000-8000-000000000001",
    executionSessionId: "00000000-0000-4000-8000-000000000002",
    projectId: "00000000-0000-4000-8000-000000000003",
    taskId: "00000000-0000-4000-8000-000000000004",
    reviewerId: "fake-reviewer",
    reviewAuthority: "DIAGNOSTIC",
    diagnostic: true,
    approvalId: "00000000-0000-4000-8000-000000000005",
    approvalStatus: "APPROVED",
    approvedReviewer: "CLAUDE",
    taskSelectedReviewer: "CLAUDE",
    executionExecutorId: "fake",
    taskTitle: "Test task", taskObjective: "Objective", taskContext: "",
    taskSpecHash: HASH, canonicalTaskSpecHash: HASH, taskNormalizedSpecHash: HASH, approvalSnapshotHash: HASH,
    executionStatus: "SUCCEEDED", executionResultStatus: "succeeded",
    executionSummary: "Fake execution completed successfully.", executionSummaryHash: HASH,
    executionCapsuleHash: HASH, executionCapsuleJsonHash: HASH,
    baselineGitEvidenceHash: HASH, finalGitEvidenceHash: HASH, verificationResultsHash: HASH, executionArtifactSetHash: HASH,
    finalBranch: "main", finalHead: "deadbeef",
    requestedAt: "2026-08-02T00:00:00.000Z", reviewPolicyVersion: "2.3A-v1"
  };
}

function capsule(scenario?: Partial<FakeReviewerScenario>): ImmutableReviewCapsule {
  const input = baseCapsule();
  const requestHash = computeRequestHash({
    reviewInputHash: computeReviewInputHash(input), reviewerConfigHash: "a".repeat(64),
    reviewerId: input.reviewerId, reviewAuthority: input.reviewAuthority, requestedBy: "tester", attempt: 0, reviewPolicyVersion: input.reviewPolicyVersion
  });
  return { ...input, requestHash, ...(scenario ? { scenario: scenario as FakeReviewerScenario } : {}) };
}

function controls(signal = new AbortController().signal): ReviewControls {
  return { signal, now: () => new Date("2026-08-02T00:00:00.000Z"), sleep: async () => {} };
}

describe("FakeReviewer", () => {
  it("describes itself as read-only, structured-output, and diagnostic-only", () => {
    const descriptor = new FakeReviewer().describe();
    expect(descriptor).toMatchObject({ id: "fake-reviewer", readOnly: true, structuredOutput: true, providerType: "FAKE" });
  });

  it("produces a valid APPROVE verdict bound to the request hash", async () => {
    const cap = capsule({ outcome: "approve" });
    const verdict = await new FakeReviewer().review(cap, controls());
    expect(verdict.verdict).toBe("APPROVE");
    expect(verdict.reviewedRequestHash).toBe(cap.requestHash);
    expect(verdict.findings.some(finding => finding.blocking)).toBe(false);
  });

  it("produces a REJECT verdict with at least one blocking finding", async () => {
    const verdict = await new FakeReviewer().review(capsule({ outcome: "reject" }), controls());
    expect(verdict.verdict).toBe("REJECT");
    expect(verdict.findings.some(finding => finding.blocking)).toBe(true);
  });

  it("produces a NEEDS_CHANGES verdict with at least one required action", async () => {
    const verdict = await new FakeReviewer().review(capsule({ outcome: "needs_changes" }), controls());
    expect(verdict.verdict).toBe("NEEDS_CHANGES");
    expect(verdict.requiredActions.length).toBeGreaterThan(0);
  });

  it("throws on the failure scenario", async () => {
    await expect(new FakeReviewer().review(capsule({ outcome: "failure" }), controls())).rejects.toThrow();
  });

  it("returns a structurally invalid payload for the invalid scenario", async () => {
    const raw = await new FakeReviewer().review(capsule({ outcome: "invalid" }), controls());
    // APPROVE with a blocking BLOCKER finding is invalid by the domain schema's own invariants.
    expect(raw.verdict).toBe("APPROVE");
    expect((raw.findings as Array<{ blocking: boolean }>).some(finding => finding.blocking)).toBe(true);
  });

  it("respects cancellation for the cancellation scenario", async () => {
    const controller = new AbortController();
    const reviewer = new FakeReviewer();
    const pending = reviewer.review(capsule({ outcome: "cancellation", delayMs: 1 }), controls(controller.signal));
    await reviewer.cancel("00000000-0000-4000-8000-000000000001");
    await expect(pending).rejects.toThrow();
  });

  it("aborts immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("stop", "AbortError"));
    await expect(new FakeReviewer().review(capsule({ outcome: "approve" }), controls(controller.signal))).rejects.toThrow();
  });

  it("honors an injected delay without using real time", async () => {
    let slept = 0;
    const cap = capsule({ outcome: "approve", delayMs: 250 });
    const fastControls: ReviewControls = { signal: new AbortController().signal, now: () => new Date(), sleep: async ms => { slept += ms; } };
    await new FakeReviewer().review(cap, fastControls);
    expect(slept).toBe(250);
  });

  it("never imports the process-runner boundary or performs filesystem/network I/O", async () => {
    const { readFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const source = await readFile(path.join(process.cwd(), "packages", "relay-v2-reviewer", "src", "fake-reviewer.ts"), "utf8");
    expect(source).not.toMatch(/node:fs|node:child_process|node:net|node:http|node:https|process-runner/);
  });
});
