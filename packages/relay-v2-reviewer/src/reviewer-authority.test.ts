import { describe, expect, it } from "vitest";
import { resolveReviewerAuthority, type ReviewerAuthorityInput } from "./reviewer-authority.js";

function input(overrides: Partial<ReviewerAuthorityInput> = {}): ReviewerAuthorityInput {
  return {
    requestedReviewerId: "fake-reviewer",
    approvalStatus: "APPROVED",
    approvalReviewerSelection: "CLAUDE",
    taskSelectedReviewer: "CLAUDE",
    executionExecutorId: "fake",
    diagnosticRequested: true,
    allowFakeExecutorDiagnosticReviews: true,
    allowCodexTestDoubleDiagnosticReviews: false,
    ...overrides
  };
}

describe("resolveReviewerAuthority", () => {
  it("accepts an eligible FakeExecutor diagnostic session as DIAGNOSTIC", () => {
    const result = resolveReviewerAuthority(input());
    expect(result).toMatchObject({ authorized: true, mode: "DIAGNOSTIC" });
  });

  it("rejects FakeReviewer for a real codex-cli session in normal runtime", () => {
    const result = resolveReviewerAuthority(input({ executionExecutorId: "codex-cli", diagnosticRequested: false, allowCodexTestDoubleDiagnosticReviews: false }));
    expect(result).toMatchObject({ authorized: false });
    expect((result as { reason: string }).reason).toMatch(/disposable test-double diagnostic gate/i);
  });

  it("rejects FakeReviewer for codex-cli even when diagnostic is requested but the runtime gate is off", () => {
    const result = resolveReviewerAuthority(input({ executionExecutorId: "codex-cli", diagnosticRequested: true, allowCodexTestDoubleDiagnosticReviews: false }));
    expect(result.authorized).toBe(false);
  });

  it("rejects FakeReviewer for codex-cli when the runtime gate is on but diagnostic was not requested", () => {
    const result = resolveReviewerAuthority(input({ executionExecutorId: "codex-cli", diagnosticRequested: false, allowCodexTestDoubleDiagnosticReviews: true }));
    expect(result.authorized).toBe(false);
  });

  it("accepts FakeReviewer for a codex-cli test-double session only when every diagnostic gate is on", () => {
    const result = resolveReviewerAuthority(input({ executionExecutorId: "codex-cli", diagnosticRequested: true, allowCodexTestDoubleDiagnosticReviews: true }));
    expect(result).toMatchObject({ authorized: true, mode: "DIAGNOSTIC" });
  });

  it("rejects a FakeExecutor session when diagnosticRequested is false", () => {
    const result = resolveReviewerAuthority(input({ diagnosticRequested: false }));
    expect(result.authorized).toBe(false);
  });

  it("rejects a FakeExecutor session when the engine diagnostic gate is off", () => {
    const result = resolveReviewerAuthority(input({ allowFakeExecutorDiagnosticReviews: false }));
    expect(result.authorized).toBe(false);
  });

  it("rejects reviewer selection NONE regardless of executor", () => {
    const result = resolveReviewerAuthority(input({ approvalReviewerSelection: "NONE", taskSelectedReviewer: "NONE" }));
    expect(result.authorized).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/NONE cannot authorize/);
  });

  it("rejects when the approval is not APPROVED", () => {
    const result = resolveReviewerAuthority(input({ approvalStatus: "INVALIDATED" }));
    expect(result.authorized).toBe(false);
  });

  it("invalidates authority when the task's reviewer selection changed since approval", () => {
    const result = resolveReviewerAuthority(input({ taskSelectedReviewer: "CODEX" }));
    expect(result.authorized).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/changed since approval/);
  });

  it("matches the requested reviewer against the approved reviewer snapshot for a real (non-fake, non-codex) reviewer mapping", () => {
    const map = { CLAUDE: "claude-reviewer" };
    const ok = resolveReviewerAuthority(input({ executionExecutorId: "codex-cli", requestedReviewerId: "claude-reviewer", diagnosticRequested: false }), map);
    expect(ok).toMatchObject({ authorized: true, mode: "AUTHORITATIVE" });
  });

  it("rejects a requested reviewer that does not match the approved reviewer snapshot", () => {
    const map = { CLAUDE: "claude-reviewer" };
    const mismatched = resolveReviewerAuthority(input({ executionExecutorId: "codex-cli", requestedReviewerId: "some-other-reviewer", diagnosticRequested: false }), map);
    expect(mismatched.authorized).toBe(false);
    expect((mismatched as { reason: string }).reason).toMatch(/does not match the approved reviewer snapshot/);
  });

  it("rejects a codex-cli review when no reviewer is mapped for the approved selection", () => {
    const result = resolveReviewerAuthority(input({ executionExecutorId: "codex-cli", requestedReviewerId: "claude-reviewer", diagnosticRequested: false }));
    expect(result.authorized).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/No reviewer is available/);
  });

  it("rejects an unreviewable executor id", () => {
    const result = resolveReviewerAuthority(input({ executionExecutorId: "some-other-executor", diagnosticRequested: false }));
    expect(result.authorized).toBe(false);
  });
});
