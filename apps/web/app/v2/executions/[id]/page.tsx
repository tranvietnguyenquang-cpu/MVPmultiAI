import Link from "next/link";
import { notFound } from "next/navigation";
import { executionStatusSchema, isTerminalExecutionStatus } from "@project-relay/relay-v2-domain";
import { RelayV2ExecutionLiveEvents } from "../../../../components/relay-v2/execution-live-events";
import { RelayV2ReviewActions } from "../../../../components/relay-v2/review-actions";
import { getRelayV2ExecutionServices, getRelayV2ReviewServices, isRelayV2ExecutionEnabled } from "../../../../lib/relay-v2/server";

export const dynamic = "force-dynamic";
export default async function RelayV2ExecutionDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ projectId?: string }> }) {
  if (!isRelayV2ExecutionEnabled()) notFound();
  const { engine, runtime } = await getRelayV2ExecutionServices();
  runtime.start();
  const session = await engine.getSession((await params).id);
  const projectId = (await searchParams).projectId;
  if (!session || (projectId && session.projectId !== projectId)) notFound();
  const timeline = await engine.timeline(session.id);
  const terminal = isTerminalExecutionStatus(executionStatusSchema.parse(session.status));
  const currentLease = session.leases.find(lease => !lease.releasedAt);
  const capsule = session.capsuleHash ? JSON.parse(session.capsuleJson) as Record<string, unknown> : undefined;
  const baseline = session.baselineEvidenceJson !== "{}" ? JSON.parse(session.baselineEvidenceJson) as Record<string, unknown> : undefined;
  const finalEvidence = session.finalEvidenceJson !== "{}" ? JSON.parse(session.finalEvidenceJson) as Record<string, unknown> : undefined;
  const verification = JSON.parse(session.verificationResultsJson) as Array<{ operation: string; passed: boolean; summary: string }>;
  const { engine: reviewEngine, runtime: reviewRuntime } = await getRelayV2ReviewServices();
  reviewRuntime.start();
  const reviews = await reviewEngine.listReviewsForExecution(session.id);
  const reviewGate = await reviewEngine.reviewGateProjection(session.id);
  const reviewEligible = session.status === "SUCCEEDED" && session.task.status === "AWAITING_USER_ACCEPTANCE";
  const reviewGateLabel = reviewGate.state === "APPROVED" && reviewGate.authority === "DIAGNOSTIC" ? "Diagnostic approval" : reviewGate.state;
  return <><div className="eyebrow">Relay v2 / Execution / {session.project.name}</div><div className="row"><h1>{session.task.title}</h1><span className={`pill ${session.status === "SUCCEEDED" ? "good" : ["FAILED", "TIMED_OUT", "BLOCKED"].includes(session.status) ? "warn" : ""}`}>{session.status}</span></div><div className="grid">
    <section className="card span8"><h2>Live Logs</h2><RelayV2ExecutionLiveEvents sessionId={session.id} projectId={session.projectId} terminal={terminal} initialEvents={session.events.map(event => ({ sequence: event.sequence, eventType: event.eventType, level: event.level, message: event.message, createdAt: event.createdAt.toISOString() }))}/></section>
    <section className="card span4"><h2>Approved Snapshot</h2><div className="stack mono"><div>Executor: {session.executorId}</div><div>Approved executor: {session.approvedExecutor}</div><div>Model: {session.approvedModel}</div><div>Effort: {session.approvedEffort}</div><div>Reviewer: {session.approvedReviewer}</div><div>Timeout: {session.approvedTimeoutSeconds}s</div><div>Spec: {session.approvedSpecHash.slice(0, 12)}...</div><div>Attempt: {session.attempt}</div></div><div className="divider"/><h3>Owned process</h3><p className="mono">{session.processId ? `PID ${session.processId} · ${session.processStartedAt?.toLocaleString() ?? "starting"}` : "Not started"}</p><p className="mono">Exit: {session.processExitCode ?? "pending"}{session.processSignal ? ` · ${session.processSignal}` : ""}</p><div className="divider"/><h3>Workspace Lease</h3><p className="mono">{currentLease ? `ACTIVE until ${currentLease.expiresAt.toLocaleString()}` : session.leases.length ? "RELEASED" : "NOT CLAIMED"}</p></section>
    {capsule ? <section className="card span12"><h2>Immutable Execution Capsule</h2><p className="mono">sha256 {session.capsuleHash}</p><pre className="log">{JSON.stringify(capsule, null, 2)}</pre></section> : null}
    <section className="card span6"><h2>Baseline Git Evidence</h2>{baseline ? <pre className="log">{JSON.stringify(baseline, null, 2)}</pre> : <p className="subtle">Not required for FakeExecutor.</p>}</section>
    <section className="card span6"><h2>Post-run Git Evidence</h2>{finalEvidence ? <pre className="log">{JSON.stringify(finalEvidence, null, 2)}</pre> : <p className="subtle">Pending or not required.</p>}</section>
    <section className="card span12"><h2>Verification</h2>{verification.length ? <div className="stack">{verification.map(result => <div className="row" key={result.operation}><strong>{result.operation}</strong><span className={`pill ${result.passed ? "good" : "warn"}`}>{result.passed ? "PASSED" : "FAILED"}</span><span>{result.summary}</span></div>)}</div> : <p className="subtle">No Relay-owned verification result recorded.</p>}</section>
    <section className="card span12"><h2>Timeline</h2><div className="stack">{timeline.map((event, index) => <div className="row" key={`${event.kind}-${event.sequence ?? index}`}><div><strong>{event.type}</strong><div className="subtle">{event.at.toLocaleString()} · {event.kind}</div></div><span className="pill">{event.level}</span><span>{event.message}</span></div>)}</div></section>
    <section className="card span6"><h2>Result</h2><p>{session.summary || "No terminal result yet."}</p>{session.failureCode ? <p className="warn mono">{session.failureCode}: {session.failureMessage}</p> : null}<p className="subtle">Duration: {session.durationMs === null ? "pending" : `${session.durationMs} ms`}</p></section>
    <section className="card span6"><h2>Artifacts</h2><div className="stack mono">{session.artifacts.map(artifact => <div key={artifact.id}><strong>{artifact.artifactType}</strong><div>{artifact.relativePath}</div><div>{artifact.byteCount} bytes · sha256 {artifact.sha256.slice(0, 16)}...{artifact.truncated ? " · truncated" : ""}</div></div>)}{!session.artifacts.length ? <p className="subtle">Artifacts are persisted as the lifecycle advances.</p> : null}</div></section>
    <section className="card span12">
      <h2>Review Gate</h2>
      <p className="subtle">Requesting a review never re-opens or reruns this execution, never modifies files, and never commits or merges. Approval only records a structured, evidence-bound verdict &mdash; the execution still requires later user acceptance or an auto-commit policy (a future milestone).</p>
      <div className="row">
        <span>Gate status:</span>
        <span className={`pill ${reviewGate.state === "APPROVED" ? "good" : ["REJECTED", "ERROR", "STALE"].includes(reviewGate.state) ? "warn" : ""}`}>{reviewGateLabel}</span>
        {reviewGate.reviewRequestId ? <span className={`pill ${reviewGate.authority === "AUTHORITATIVE" ? "" : "warn"}`}>{reviewGate.authority}</span> : null}
      </div>
      <p className="subtle">Commit-authority eligible: {reviewGate.commitAuthorityEligible ? "yes" : "no"} &mdash; Milestone 2.3A has no auto-commit policy, so this is always &ldquo;no&rdquo;.</p>
      <RelayV2ReviewActions sessionId={session.id} projectId={session.projectId} eligible={reviewEligible} />
      {reviews.length ? <div className="stack mono">{reviews.map(review => {
        const label = review.status === "APPROVED" && review.reviewAuthority === "DIAGNOSTIC" ? "Diagnostic approval" : review.status;
        return <div className="row" key={review.id}><Link href={`/v2/reviews/${review.id}?projectId=${session.projectId}`}>{review.id.slice(0, 8)}...</Link><span className={`pill ${review.status === "APPROVED" ? "good" : ["REJECTED", "ERROR", "STALE"].includes(review.status) ? "warn" : ""}`}>{label}</span><span>attempt {review.attempt}</span></div>;
      })}</div> : <p className="subtle">No review has been requested for this execution yet.</p>}
    </section>
  </div></>;
}
