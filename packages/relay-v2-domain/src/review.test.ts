import { describe, expect, it } from "vitest";
import {
  assertReviewTransition,
  canTransitionReview,
  isTerminalReviewStatus,
  reviewRequestStatusSchema,
  structuredReviewVerdictSchema,
  TERMINAL_REVIEW_STATUSES,
  type ReviewRequestStatus
} from "./review.js";

const HASH = "a".repeat(64);

function verdict(overrides: Partial<Parameters<typeof structuredReviewVerdictSchema.parse>[0]> = {}) {
  return {
    reviewedRequestHash: HASH,
    verdict: "APPROVE",
    summary: "Looks good.",
    findings: [],
    requiredActions: [],
    confidence: 1,
    reviewerVersion: "fake-reviewer@1",
    ...overrides
  };
}

describe("Relay v2 review state machine", () => {
  it("allows PENDING -> CLAIMED -> RUNNING -> each direct terminal outcome", () => {
    // RUNNING never reaches CANCELLED directly — cancellation must pass through
    // CANCELLATION_REQUESTED so it can race a verdict via a CAS update.
    const outcomes: ReviewRequestStatus[] = ["APPROVED", "REJECTED", "NEEDS_CHANGES", "ERROR", "STALE"];
    expect(canTransitionReview("PENDING", "CLAIMED")).toBe(true);
    expect(canTransitionReview("CLAIMED", "RUNNING")).toBe(true);
    expect(canTransitionReview("RUNNING", "CANCELLED")).toBe(false);
    for (const outcome of outcomes) {
      expect(canTransitionReview("RUNNING", outcome)).toBe(true);
      expect(() => assertReviewTransition("RUNNING", outcome)).not.toThrow();
    }
  });

  it("allows PENDING to short-circuit to CANCELLED, STALE, or ERROR", () => {
    expect(canTransitionReview("PENDING", "CANCELLED")).toBe(true);
    expect(canTransitionReview("PENDING", "STALE")).toBe(true);
    expect(canTransitionReview("PENDING", "ERROR")).toBe(true);
  });

  it("routes cancellation through CANCELLATION_REQUESTED once claimed", () => {
    expect(canTransitionReview("PENDING", "CANCELLATION_REQUESTED")).toBe(false);
    expect(canTransitionReview("CLAIMED", "CANCELLATION_REQUESTED")).toBe(true);
    expect(canTransitionReview("RUNNING", "CANCELLATION_REQUESTED")).toBe(true);
    expect(canTransitionReview("CANCELLATION_REQUESTED", "CANCELLED")).toBe(true);
    expect(canTransitionReview("CANCELLATION_REQUESTED", "ERROR")).toBe(true);
    expect(canTransitionReview("CANCELLATION_REQUESTED", "STALE")).toBe(true);
    expect(canTransitionReview("CANCELLATION_REQUESTED", "APPROVED")).toBe(false);
  });

  it("rejects transitions out of terminal states", () => {
    for (const status of TERMINAL_REVIEW_STATUSES) {
      expect(isTerminalReviewStatus(status)).toBe(true);
      expect(() => assertReviewTransition(status, "RUNNING")).toThrow(/cannot transition/i);
      expect(() => assertReviewTransition(status, "PENDING")).toThrow(/cannot transition/i);
    }
  });

  it("rejects skipping PENDING to a terminal reviewer outcome directly without RUNNING marker for APPROVED", () => {
    expect(reviewRequestStatusSchema.parse("PENDING")).toBe("PENDING");
    expect(canTransitionReview("PENDING", "APPROVED")).toBe(false);
    expect(canTransitionReview("PENDING", "REJECTED")).toBe(false);
    expect(canTransitionReview("PENDING", "NEEDS_CHANGES")).toBe(false);
  });
});

describe("Structured review verdict invariants", () => {
  it("accepts a clean APPROVE with no blocking findings", () => {
    expect(() => structuredReviewVerdictSchema.parse(verdict())).not.toThrow();
  });

  it("rejects APPROVE containing a blocking BLOCKER finding", () => {
    const result = structuredReviewVerdictSchema.safeParse(verdict({
      verdict: "APPROVE",
      findings: [{ id: "f1", severity: "BLOCKER", category: "correctness", title: "Bug", description: "Broken", evidenceReferences: [], blocking: true }]
    }));
    expect(result.success).toBe(false);
  });

  it("rejects APPROVE containing a blocking HIGH finding", () => {
    const result = structuredReviewVerdictSchema.safeParse(verdict({
      verdict: "APPROVE",
      findings: [{ id: "f1", severity: "HIGH", category: "correctness", title: "Bug", description: "Broken", evidenceReferences: [], blocking: true }]
    }));
    expect(result.success).toBe(false);
  });

  it("allows APPROVE with a non-blocking LOW finding", () => {
    const result = structuredReviewVerdictSchema.safeParse(verdict({
      verdict: "APPROVE",
      findings: [{ id: "f1", severity: "LOW", category: "style", title: "Nit", description: "Minor", evidenceReferences: [], blocking: false }]
    }));
    expect(result.success).toBe(true);
  });

  it("rejects REJECT with no blocking finding", () => {
    const result = structuredReviewVerdictSchema.safeParse(verdict({ verdict: "REJECT", findings: [] }));
    expect(result.success).toBe(false);
  });

  it("accepts REJECT with at least one blocking finding", () => {
    const result = structuredReviewVerdictSchema.safeParse(verdict({
      verdict: "REJECT",
      findings: [{ id: "f1", severity: "BLOCKER", category: "correctness", title: "Bug", description: "Broken", evidenceReferences: [], blocking: true }]
    }));
    expect(result.success).toBe(true);
  });

  it("rejects NEEDS_CHANGES with no required actions", () => {
    const result = structuredReviewVerdictSchema.safeParse(verdict({ verdict: "NEEDS_CHANGES", requiredActions: [] }));
    expect(result.success).toBe(false);
  });

  it("accepts NEEDS_CHANGES with at least one required action", () => {
    const result = structuredReviewVerdictSchema.safeParse(verdict({ verdict: "NEEDS_CHANGES", requiredActions: ["Add a test."] }));
    expect(result.success).toBe(true);
  });

  it("rejects unknown fields instead of silently granting them authority", () => {
    const result = structuredReviewVerdictSchema.safeParse({ ...verdict(), commitAuthorized: true });
    expect(result.success).toBe(false);
  });

  it("rejects a malformed reviewedRequestHash", () => {
    const result = structuredReviewVerdictSchema.safeParse(verdict({ reviewedRequestHash: "not-a-hash" }));
    expect(result.success).toBe(false);
  });
});
