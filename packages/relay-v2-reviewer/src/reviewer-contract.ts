import type { FakeReviewerScenario, ReviewerDescriptor, StructuredReviewVerdict } from "@project-relay/relay-v2-domain";
import type { ReviewInputCapsule } from "./review-binding.js";

export type ReviewerValidationRequest = {
  reviewRequestId: string;
  executionSessionId: string;
  reviewerConfig: Record<string, unknown>;
};

export type ReviewerValidationResult = { valid: true } | { valid: false; reason: string };

/**
 * Everything a reviewer is permitted to see: exactly the persisted, hash-bound
 * ReviewInputCapsule, plus (for fake-reviewer only) the separately-frozen
 * scenario config. Read-only: reviewers never receive a workspace path,
 * process handle, or credential of any kind. A reviewer must never be handed
 * any additional task/execution field assembled outside this capsule.
 */
export type ImmutableReviewCapsule = ReviewInputCapsule & {
  requestHash: string;
  scenario?: FakeReviewerScenario;
};

export type ReviewControls = {
  signal: AbortSignal;
  now(): Date;
  sleep(milliseconds: number): Promise<void>;
};

export type ReviewerHealth = {
  healthy: boolean;
  checkedAt: string;
  message: string;
};

export interface RelayReviewer {
  readonly id: string;
  describe(): ReviewerDescriptor;
  validate(request: ReviewerValidationRequest): Promise<ReviewerValidationResult>;
  review(capsule: ImmutableReviewCapsule, controls: ReviewControls): Promise<StructuredReviewVerdict>;
  cancel?(reviewRequestId: string): Promise<void>;
  health(): Promise<ReviewerHealth>;
}
