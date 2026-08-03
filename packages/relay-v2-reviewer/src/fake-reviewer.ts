import {
  fakeReviewerScenarioSchema,
  reviewerDescriptorSchema,
  structuredReviewVerdictSchema,
  type ReviewerDescriptor,
  type StructuredReviewVerdict
} from "@project-relay/relay-v2-domain";
import type {
  ImmutableReviewCapsule,
  RelayReviewer,
  ReviewControls,
  ReviewerHealth,
  ReviewerValidationRequest,
  ReviewerValidationResult
} from "./reviewer-contract.js";

/**
 * In-process, read-only, diagnostic-only reviewer. Never touches the
 * filesystem, Git, a child process, or the network, and never receives a
 * workspace path — only the immutable, already-hashed review capsule.
 */
export class FakeReviewer implements RelayReviewer {
  readonly id = "fake-reviewer";
  private readonly cancelled = new Set<string>();

  describe(): ReviewerDescriptor {
    return reviewerDescriptorSchema.parse({
      id: this.id,
      displayName: "Fake Reviewer (diagnostic only)",
      providerType: "FAKE",
      readOnly: true,
      structuredOutput: true,
      cancellationSupport: true,
      capabilities: ["deterministic-verdicts", "in-process-simulation"]
    });
  }

  async validate(request: ReviewerValidationRequest): Promise<ReviewerValidationResult> {
    return request.executionSessionId ? { valid: true } : { valid: false, reason: "An execution session is required." };
  }

  async review(capsule: ImmutableReviewCapsule, controls: ReviewControls): Promise<StructuredReviewVerdict> {
    const scenario = fakeReviewerScenarioSchema.parse(capsule.scenario ?? {});
    if (scenario.delayMs > 0) await controls.sleep(scenario.delayMs);
    if (controls.signal.aborted || this.cancelled.has(capsule.reviewRequestId)) {
      throw controls.signal.reason ?? new DOMException("Review cancelled.", "AbortError");
    }
    if (scenario.outcome === "cancellation") {
      while (!controls.signal.aborted && !this.cancelled.has(capsule.reviewRequestId)) {
        await controls.sleep(Math.max(1, scenario.delayMs || 5));
      }
      throw controls.signal.reason ?? new DOMException("Review cancelled.", "AbortError");
    }
    if (scenario.outcome === "failure") throw new Error("FakeReviewer scenario was configured to fail.");
    if (scenario.outcome === "invalid") {
      // Deliberately structurally invalid (APPROVE with a blocking BLOCKER finding) so
      // ReviewEngine's own re-validation — never the reviewer's self-report — decides
      // this becomes ERROR, not APPROVE. Bypasses local schema validation on purpose.
      return {
        reviewedRequestHash: capsule.requestHash,
        verdict: "APPROVE",
        summary: scenario.summary,
        findings: [{
          id: "invalid-finding", severity: "BLOCKER", category: "diagnostic", title: "Invalid combination",
          description: "FakeReviewer scenario deliberately returns an invalid verdict/finding combination.",
          evidenceReferences: [], blocking: true
        }],
        requiredActions: [],
        confidence: 1,
        reviewerVersion: "fake-reviewer@1"
      } as unknown as StructuredReviewVerdict;
    }
    const base = { reviewedRequestHash: capsule.requestHash, summary: scenario.summary, confidence: 1, reviewerVersion: "fake-reviewer@1" };
    if (scenario.outcome === "reject") {
      const findings = scenario.findings.length ? scenario.findings : [{
        id: "fake-reject-1", severity: "BLOCKER" as const, category: "diagnostic", title: "Fake rejection",
        description: "FakeReviewer scenario was configured to reject.", evidenceReferences: [], blocking: true
      }];
      return structuredReviewVerdictSchema.parse({ ...base, verdict: "REJECT", findings, requiredActions: scenario.requiredActions });
    }
    if (scenario.outcome === "needs_changes") {
      const requiredActions = scenario.requiredActions.length ? scenario.requiredActions : ["Address the fake reviewer's requested change."];
      return structuredReviewVerdictSchema.parse({ ...base, verdict: "NEEDS_CHANGES", findings: scenario.findings, requiredActions });
    }
    return structuredReviewVerdictSchema.parse({
      ...base, verdict: "APPROVE", findings: scenario.findings.filter(finding => !finding.blocking), requiredActions: scenario.requiredActions
    });
  }

  async cancel(reviewRequestId: string): Promise<void> { this.cancelled.add(reviewRequestId); }
  async health(): Promise<ReviewerHealth> {
    return { healthy: true, checkedAt: new Date().toISOString(), message: "In-process FakeReviewer is ready. Diagnostic only — never use for a real review decision." };
  }
}
