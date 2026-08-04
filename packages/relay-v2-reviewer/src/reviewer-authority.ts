import type { ReviewAuthority, ReviewerSelection } from "@project-relay/relay-v2-domain";

/**
 * Runtime reviewer id that an approved `ReviewerSelection` resolves to.
 * Milestone 2.3B populates CLAUDE -> "claude-cli": the first, and so far
 * only, reviewer selection that can resolve to an AUTHORITATIVE verdict. NONE
 * and an unmapped selection are unauthorizable by construction (see below);
 * there is deliberately no CODEX entry yet.
 */
export type ReviewerIdBySelection = Partial<Record<ReviewerSelection, string>>;
export const PRODUCTION_REVIEWER_ID_BY_SELECTION: ReviewerIdBySelection = {
  CLAUDE: "claude-cli"
};

export type ReviewerAuthorityInput = {
  requestedReviewerId: string;
  approvalStatus: string;
  approvalReviewerSelection: ReviewerSelection;
  taskSelectedReviewer: ReviewerSelection;
  executionExecutorId: string;
  diagnosticRequested: boolean;
  /** FakeExecutor sessions are reviewable only under this narrow diagnostic gate. */
  allowFakeExecutorDiagnosticReviews: boolean;
  /** A codex-cli (including Codex test-double) session is reviewable by FakeReviewer only under this narrow, separately-gated diagnostic path. */
  allowCodexTestDoubleDiagnosticReviews: boolean;
};

export type ReviewerAuthorityResult =
  | { authorized: true; mode: ReviewAuthority }
  | { authorized: false; reason: string };

/**
 * Pure authority-matching decision. Never trusts the caller's claim about
 * what was approved — every field here must be re-derived by the caller from
 * current source-of-truth rows (Approval/Task/ExecutionSession), both at
 * request time and again during final verdict revalidation.
 */
export function resolveReviewerAuthority(
  input: ReviewerAuthorityInput,
  reviewerIdBySelection: ReviewerIdBySelection = PRODUCTION_REVIEWER_ID_BY_SELECTION
): ReviewerAuthorityResult {
  if (input.approvalStatus !== "APPROVED") {
    return { authorized: false, reason: "The task approval used for this execution is not APPROVED." };
  }
  if (input.approvalReviewerSelection === "NONE") {
    return { authorized: false, reason: "Reviewer selection NONE cannot authorize a review." };
  }
  if (input.taskSelectedReviewer !== input.approvalReviewerSelection) {
    return { authorized: false, reason: "The task's reviewer selection changed since approval; a new task approval is required." };
  }

  if (input.executionExecutorId === "fake") {
    if (!(input.diagnosticRequested && input.allowFakeExecutorDiagnosticReviews)) {
      return { authorized: false, reason: "A FakeExecutor diagnostic session requires both an explicit diagnostic request and the runtime diagnostic gate." };
    }
    if (input.requestedReviewerId !== "fake-reviewer") {
      return { authorized: false, reason: "Only fake-reviewer may review a FakeExecutor diagnostic session." };
    }
    return { authorized: true, mode: "DIAGNOSTIC" };
  }

  if (input.requestedReviewerId === "fake-reviewer") {
    if (input.diagnosticRequested && input.allowCodexTestDoubleDiagnosticReviews) return { authorized: true, mode: "DIAGNOSTIC" };
    return { authorized: false, reason: "FakeReviewer cannot review a codex-cli execution outside the disposable test-double diagnostic gate." };
  }

  const expectedReviewerId = reviewerIdBySelection[input.approvalReviewerSelection];
  if (!expectedReviewerId) {
    return { authorized: false, reason: `No reviewer is available in this runtime for the approved reviewer selection '${input.approvalReviewerSelection}'.` };
  }
  if (input.requestedReviewerId !== expectedReviewerId) {
    return { authorized: false, reason: "Requested reviewer does not match the approved reviewer snapshot." };
  }
  return { authorized: true, mode: "AUTHORITATIVE" };
}
