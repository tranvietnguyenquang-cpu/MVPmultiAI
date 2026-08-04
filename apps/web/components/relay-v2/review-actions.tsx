"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { relayV2Fetch } from "../../lib/relay-v2/client";

type FakeReviewerOutcome = "approve" | "reject" | "needs_changes" | "invalid" | "failure" | "cancellation";

type ClaudeDiagnostics = {
  descriptor: { displayName: string };
  health: { healthy: boolean; message: string; checkedAt: string };
  latest: { displayPath: string; version: string; authenticationStatus: string; supported: boolean; unsupportedReasons: string[]; detectedAt: string } | null;
};

function ClaudeReviewerDiagnostics({ projectId }: { projectId: string }) {
  const [diagnostics, setDiagnostics] = useState<ClaudeDiagnostics | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    const response = await relayV2Fetch(`/api/v2/reviewers/claude-cli/diagnostics?projectId=${encodeURIComponent(projectId)}`);
    if (response.ok) setDiagnostics(await response.json() as ClaudeDiagnostics);
  }

  useEffect(() => { void load(); }, []);

  async function refresh() {
    setBusy(true);
    try {
      await relayV2Fetch(`/api/v2/reviewers/claude-cli/diagnostics?projectId=${encodeURIComponent(projectId)}`, { method: "POST" });
      await load();
    } finally { setBusy(false); }
  }

  return <div className="stack mono">
    <div className="row">
      <span>Claude CLI:</span>
      <span className={`pill ${diagnostics?.health.healthy ? "good" : "warn"}`}>{diagnostics ? (diagnostics.health.healthy ? "Ready" : "Not ready") : "Checking..."}</span>
      <button disabled={busy} onClick={refresh}>Refresh diagnostics</button>
    </div>
    {diagnostics?.latest ? <div className="stack">
      <div>{diagnostics.latest.displayPath} {diagnostics.latest.version ? `· v${diagnostics.latest.version}` : ""}</div>
      <div>Authentication: {diagnostics.latest.authenticationStatus}</div>
      <div>Last checked: {new Date(diagnostics.latest.detectedAt).toLocaleString()}</div>
      {diagnostics.latest.unsupportedReasons.length ? <div className="subtle">{diagnostics.latest.unsupportedReasons.join(" ")}</div> : null}
    </div> : <p className="subtle">{diagnostics ? diagnostics.health.message : "Loading Claude CLI capability..."}</p>}
  </div>;
}

export function RelayV2ReviewActions({ sessionId, projectId, eligible, approvedReviewer }: { sessionId: string; projectId: string; eligible: boolean; approvedReviewer: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [outcome, setOutcome] = useState<FakeReviewerOutcome>("approve");

  async function requestReview(reviewerId: "fake-reviewer" | "claude-cli") {
    setBusy(true); setError("");
    try {
      const body = reviewerId === "fake-reviewer"
        // fake-reviewer never produces an AUTHORITATIVE verdict — this is always a diagnostic request.
        ? { reviewerId, diagnostic: true, reviewerConfig: { outcome } }
        // claude-cli's config is entirely server-derived (see contracts.ts); no reviewerConfig is sent.
        : { reviewerId, diagnostic: false };
      const response = await relayV2Fetch(`/api/v2/executions/${sessionId}/reviews?projectId=${encodeURIComponent(projectId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      const result = await response.json() as { error?: string; reviewRequest?: { id: string } };
      if (!response.ok || !result.reviewRequest) throw new Error(result.error ?? "Could not request a review.");
      router.push(`/v2/reviews/${result.reviewRequest.id}?projectId=${projectId}`);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not request a review."); }
    finally { setBusy(false); }
  }

  if (!eligible) return <p className="subtle">Review is available once this execution reaches AWAITING_USER_ACCEPTANCE with a successful, evidence-complete result.</p>;

  return <div className="stack">
    {approvedReviewer === "CLAUDE" ? <div className="stack">
      <p className="subtle">This task was approved for the real Claude CLI reviewer. A Claude review runs your local, subscription-authenticated Claude Code CLI once, read-only, against a disposable bundle of only the bound evidence below &mdash; it never sees the live workspace, never uses any tool, and never modifies, commits, or merges anything.</p>
      <ClaudeReviewerDiagnostics projectId={projectId} />
      <button disabled={busy} onClick={() => requestReview("claude-cli")}>Request Claude Review (authoritative)</button>
      <div className="divider"/>
    </div> : null}
    <p className="subtle">FakeReviewer is diagnostic-only. A review approval never commits, merges, or accepts the execution &mdash; it only records a structured, evidence-bound verdict.</p>
    <label>Reviewer scenario<select aria-label="Fake reviewer scenario" value={outcome} onChange={event => setOutcome(event.target.value as FakeReviewerOutcome)}>
      <option value="approve">Approve</option>
      <option value="reject">Reject</option>
      <option value="needs_changes">Needs changes</option>
      <option value="invalid">Invalid response (diagnostic)</option>
      <option value="failure">Reviewer failure</option>
      <option value="cancellation">Cancellation</option>
    </select></label>
    <button disabled={busy} onClick={() => requestReview("fake-reviewer")}>Request Review (diagnostic)</button>
    {error ? <p className="warn">{error}</p> : null}
  </div>;
}
