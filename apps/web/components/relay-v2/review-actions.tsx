"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { relayV2Fetch } from "../../lib/relay-v2/client";

type FakeReviewerOutcome = "approve" | "reject" | "needs_changes" | "invalid" | "failure" | "cancellation";

export function RelayV2ReviewActions({ sessionId, projectId, eligible }: { sessionId: string; projectId: string; eligible: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [outcome, setOutcome] = useState<FakeReviewerOutcome>("approve");

  async function requestReview() {
    setBusy(true); setError("");
    try {
      // fake-reviewer never produces an AUTHORITATIVE verdict, whether it is reviewing a
      // FakeExecutor diagnostic session or (only under a disposable test-double gate) a
      // codex-cli session — so this is always a diagnostic request.
      const response = await relayV2Fetch(`/api/v2/executions/${sessionId}/reviews?projectId=${encodeURIComponent(projectId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reviewerId: "fake-reviewer", diagnostic: true, reviewerConfig: { outcome } })
      });
      const result = await response.json() as { error?: string; reviewRequest?: { id: string } };
      if (!response.ok || !result.reviewRequest) throw new Error(result.error ?? "Could not request a review.");
      router.push(`/v2/reviews/${result.reviewRequest.id}?projectId=${projectId}`);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not request a review."); }
    finally { setBusy(false); }
  }

  if (!eligible) return <p className="subtle">Review is available once this execution reaches AWAITING_USER_ACCEPTANCE with a successful, evidence-complete result.</p>;

  return <div className="stack">
    <p className="subtle">FakeReviewer is diagnostic-only. A review approval never commits, merges, or accepts the execution &mdash; it only records a structured, evidence-bound verdict.</p>
    <label>Reviewer scenario<select aria-label="Fake reviewer scenario" value={outcome} onChange={event => setOutcome(event.target.value as FakeReviewerOutcome)}>
      <option value="approve">Approve</option>
      <option value="reject">Reject</option>
      <option value="needs_changes">Needs changes</option>
      <option value="invalid">Invalid response (diagnostic)</option>
      <option value="failure">Reviewer failure</option>
      <option value="cancellation">Cancellation</option>
    </select></label>
    <button disabled={busy} onClick={requestReview}>Request Review</button>
    {error ? <p className="warn">{error}</p> : null}
  </div>;
}
