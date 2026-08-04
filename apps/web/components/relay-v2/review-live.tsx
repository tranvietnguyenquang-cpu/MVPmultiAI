"use client";

import { useEffect, useRef, useState } from "react";
import { relayV2Fetch } from "../../lib/relay-v2/client";

type Finding = { id: string; severity: "BLOCKER" | "HIGH" | "MEDIUM" | "LOW" | "INFO"; category: string; title: string; description: string; evidenceReferences: string[]; requiredAction?: string; blocking: boolean };
type Verdict = { id: string; verdict: "APPROVE" | "REJECT" | "NEEDS_CHANGES"; summary: string; findingsJson: string; requiredActionsJson: string; confidence: number; reviewerVersion: string; reviewedRequestHash: string; createdAt: string };
type ReviewEvent = { sequence: number; eventType: string; level: string; message: string; createdAt: string };
export type ReviewRequestDto = {
  id: string; status: string; reviewerId: string; reviewAuthority: "AUTHORITATIVE" | "DIAGNOSTIC"; attempt: number; requestHash: string;
  taskSpecHash: string; approvalSnapshotHash: string; executionCapsuleHash: string; baselineGitEvidenceHash: string;
  finalGitEvidenceHash: string; verificationResultsHash: string; executionArtifactSetHash: string;
  finalBranch: string; finalHead: string; failureCode?: string | null; failureMessage?: string | null;
  requestedAt: string; startedAt?: string | null; finishedAt?: string | null; invalidatedAt?: string | null;
  verdicts: Verdict[]; events: ReviewEvent[];
};

export type LatestInvocationDto = { status: string; reviewerId: string; cliVersion: string; reviewMaterialHash: string; promptHash: string } | null;

const TERMINAL = new Set(["APPROVED", "REJECTED", "NEEDS_CHANGES", "ERROR", "CANCELLED", "STALE"]);
const CANCELLING = new Set(["CANCELLATION_REQUESTED"]);
const SEVERITY_ORDER = ["BLOCKER", "HIGH", "MEDIUM", "LOW", "INFO"] as const;

function statusPillClass(status: string): string {
  if (["APPROVED"].includes(status)) return "good";
  if (["REJECTED", "ERROR", "STALE"].includes(status)) return "warn";
  return "";
}

export function RelayV2ReviewLive({ reviewRequestId, projectId, initial, initialInvocation }: { reviewRequestId: string; projectId: string; initial: ReviewRequestDto; initialInvocation?: LatestInvocationDto }) {
  const [review, setReview] = useState(initial);
  const [invocation, setInvocation] = useState<LatestInvocationDto>(initialInvocation ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const terminal = TERMINAL.has(review.status);
  const stopped = useRef(terminal);

  useEffect(() => {
    if (TERMINAL.has(review.status)) { stopped.current = true; return; }
    stopped.current = false;
    let cancelled = false;
    async function poll() {
      while (!cancelled && !stopped.current) {
        try {
          const response = await relayV2Fetch(`/api/v2/reviews/${reviewRequestId}?projectId=${encodeURIComponent(projectId)}`);
          if (response.ok) {
            const result = await response.json() as { reviewRequest: ReviewRequestDto; latestInvocation: LatestInvocationDto };
            if (!cancelled) {
              setReview(result.reviewRequest);
              setInvocation(result.latestInvocation);
              if (TERMINAL.has(result.reviewRequest.status)) stopped.current = true;
            }
          }
        } catch { /* transient; retry on next tick */ }
        await new Promise(resolve => setTimeout(resolve, 400));
      }
    }
    void poll();
    return () => { cancelled = true; };
  }, [reviewRequestId, projectId]);

  async function cancel() {
    setBusy(true); setError("");
    try {
      const response = await relayV2Fetch(`/api/v2/reviews/${reviewRequestId}/cancel?projectId=${encodeURIComponent(projectId)}`, { method: "POST" });
      const result = await response.json() as { error?: string; reviewRequest?: ReviewRequestDto };
      if (!response.ok) throw new Error(result.error ?? "Could not cancel the review.");
      if (result.reviewRequest) setReview(result.reviewRequest);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not cancel the review."); }
    finally { setBusy(false); }
  }

  const verdict = review.verdicts.at(-1);
  const findings: Finding[] = verdict ? JSON.parse(verdict.findingsJson) as Finding[] : [];
  const requiredActions: string[] = verdict ? JSON.parse(verdict.requiredActionsJson) as string[] : [];

  const statusLabel = review.status === "APPROVED" && review.reviewAuthority === "DIAGNOSTIC" ? "Diagnostic approval" : review.status;

  return <div className="stack">
    <div className="row">
      <span className={`pill ${statusPillClass(review.status)}`}>{statusLabel}</span>
      <span className={`pill ${review.reviewAuthority === "AUTHORITATIVE" ? "" : "warn"}`}>{review.reviewAuthority}</span>
      {review.status === "STALE" ? <span className="warn">Execution evidence changed after this review was requested; the verdict was not accepted. Request a new review.</span> : null}
      {!terminal ? <button className="button secondary" disabled={busy || CANCELLING.has(review.status)} onClick={cancel}>{CANCELLING.has(review.status) ? "Cancelling…" : "Cancel Review"}</button> : null}
    </div>
    {review.reviewAuthority === "DIAGNOSTIC" ? <p className="subtle">DIAGNOSTIC review: this verdict is displayable but can never satisfy a future auto-commit or acceptance gate.</p> : null}
    {invocation ? <section className="card mono">
      <h3>Reviewer Invocation</h3>
      <div className="stack">
        <div>Reviewer: {invocation.reviewerId} {invocation.cliVersion ? `· v${invocation.cliVersion}` : ""}</div>
        <div>Invocation status: <span className="pill">{invocation.status}</span></div>
        {invocation.reviewMaterialHash ? <div>Material hash: {invocation.reviewMaterialHash.slice(0, 16)}...</div> : null}
        {invocation.promptHash ? <div>Prompt hash: {invocation.promptHash.slice(0, 16)}...</div> : null}
      </div>
    </section> : null}
    {error ? <p className="warn">{error}</p> : null}
    {review.failureCode ? <p className="warn mono">{review.failureCode}: {review.failureMessage}</p> : null}

    {verdict ? <section className="card">
      <h3>Structured Verdict: {verdict.verdict}</h3>
      <p>{verdict.summary}</p>
      <p className="mono subtle">reviewedRequestHash {verdict.reviewedRequestHash.slice(0, 16)}... &middot; confidence {verdict.confidence} &middot; {verdict.reviewerVersion}</p>
      {requiredActions.length ? <><h4>Required Actions</h4><ul>{requiredActions.map((action, index) => <li key={index}>{action}</li>)}</ul></> : null}
      {findings.length ? <><h4>Findings</h4><div className="stack">
        {[...findings].sort((left, right) => SEVERITY_ORDER.indexOf(left.severity) - SEVERITY_ORDER.indexOf(right.severity)).map(finding => (
          <div className="row" key={finding.id}>
            <span className={`pill ${finding.severity === "BLOCKER" || finding.severity === "HIGH" ? "warn" : ""}`}>{finding.severity}</span>
            <div><strong>{finding.title}</strong> <span className="subtle">({finding.category}{finding.blocking ? ", blocking" : ""})</span><div>{finding.description}</div>{finding.requiredAction ? <div className="subtle">Required: {finding.requiredAction}</div> : null}</div>
          </div>
        ))}
      </div></> : <p className="subtle">No findings reported.</p>}
    </section> : <p className="subtle">No structured verdict yet.</p>}

    <section className="card">
      <h3>Review Timeline</h3>
      <div className="stack">{review.events.map(event => <div className="row" key={event.sequence}><span>#{event.sequence} {event.eventType}</span><span className={`pill ${event.level === "ERROR" || event.level === "WARNING" ? "warn" : ""}`}>{event.level}</span><span>{event.message}</span></div>)}</div>
    </section>
  </div>;
}
