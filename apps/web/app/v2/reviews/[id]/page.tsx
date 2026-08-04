import Link from "next/link";
import { notFound } from "next/navigation";
import { RelayV2ReviewLive, type ReviewRequestDto } from "../../../../components/relay-v2/review-live";
import { getRelayV2ExecutionServices, getRelayV2ReviewServices, isRelayV2ExecutionEnabled } from "../../../../lib/relay-v2/server";

export const dynamic = "force-dynamic";

export default async function RelayV2ReviewDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ projectId?: string }> }) {
  if (!isRelayV2ExecutionEnabled()) notFound();
  const { engine: reviewEngine, runtime: reviewRuntime } = await getRelayV2ReviewServices();
  const reviewRequest = await reviewEngine.getReviewRequest((await params).id);
  const projectId = (await searchParams).projectId;
  if (!reviewRequest || (projectId && reviewRequest.projectId !== projectId)) notFound();
  reviewRuntime.start();

  const latestInvocation = await reviewEngine.latestInvocation(reviewRequest.id);

  const { engine: executionEngine } = await getRelayV2ExecutionServices();
  const session = await executionEngine.getSession(reviewRequest.executionSessionId);
  const verification = session ? JSON.parse(session.verificationResultsJson) as Array<{ operation: string; passed: boolean; summary: string }> : [];

  const dto: ReviewRequestDto = {
    id: reviewRequest.id, status: reviewRequest.status, reviewerId: reviewRequest.reviewerId,
    reviewAuthority: reviewRequest.reviewAuthority as ReviewRequestDto["reviewAuthority"], attempt: reviewRequest.attempt,
    requestHash: reviewRequest.requestHash, taskSpecHash: reviewRequest.taskSpecHash, approvalSnapshotHash: reviewRequest.approvalSnapshotHash,
    executionCapsuleHash: reviewRequest.executionCapsuleHash, baselineGitEvidenceHash: reviewRequest.baselineGitEvidenceHash,
    finalGitEvidenceHash: reviewRequest.finalGitEvidenceHash, verificationResultsHash: reviewRequest.verificationResultsHash,
    executionArtifactSetHash: reviewRequest.executionArtifactSetHash, finalBranch: reviewRequest.finalBranch, finalHead: reviewRequest.finalHead,
    failureCode: reviewRequest.failureCode, failureMessage: reviewRequest.failureMessage,
    requestedAt: reviewRequest.requestedAt.toISOString(), startedAt: reviewRequest.startedAt?.toISOString() ?? null,
    finishedAt: reviewRequest.finishedAt?.toISOString() ?? null, invalidatedAt: reviewRequest.invalidatedAt?.toISOString() ?? null,
    verdicts: reviewRequest.verdicts.map(verdict => ({ ...verdict, verdict: verdict.verdict as ReviewRequestDto["verdicts"][number]["verdict"], createdAt: verdict.createdAt.toISOString() })),
    events: reviewRequest.events.map(event => ({ sequence: event.sequence, eventType: event.eventType, level: event.level, message: event.message, createdAt: event.createdAt.toISOString() }))
  };

  return <>
    <div className="eyebrow">Relay v2 / Review {reviewRequest.reviewAuthority === "DIAGNOSTIC" ? "(diagnostic-only)" : ""}</div>
    <div className="row"><h1>Review of {session?.task.title ?? "execution"}</h1></div>
    <p className="subtle">A review approval never commits, merges, or auto-accepts an execution. The execution still requires later user acceptance or an auto-commit policy (a future milestone).</p>
    <div className="grid">
      <section className="card span6">
        <h2>Linked Execution</h2>
        {session ? <div className="stack mono">
          <div><Link href={`/v2/executions/${session.id}?projectId=${session.projectId}`}>{session.id}</Link></div>
          <div>Task: {session.task.title}</div>
          <div>Project: {session.project.name}</div>
          <div>Executor: {session.executorId}</div>
          <div>Result status: {reviewRequest.executionResultStatus}</div>
        </div> : <p className="subtle">Execution session no longer available.</p>}
      </section>
      <section className="card span6">
        <h2>Reviewer</h2>
        <div className="stack mono">
          <div>Reviewer: {reviewRequest.reviewerId}</div>
          <div>Authority: {reviewRequest.reviewAuthority}</div>
          <div>Attempt: {reviewRequest.attempt}</div>
          <div>Request hash: {reviewRequest.requestHash.slice(0, 16)}...</div>
          <div>Requested: {reviewRequest.requestedAt.toLocaleString()}</div>
        </div>
        {reviewRequest.reviewAuthority === "DIAGNOSTIC" ? <p className="warn">This is a DIAGNOSTIC review and must never be treated as a real code review or production approval &mdash; it can never satisfy a future auto-commit gate.</p> : null}
      </section>
      <section className="card span12">
        <h2>Reviewed Evidence Hashes</h2>
        <div className="stack mono">
          <div>Task spec: {reviewRequest.taskSpecHash}</div>
          <div>Approval snapshot: {reviewRequest.approvalSnapshotHash}</div>
          <div>Execution capsule: {reviewRequest.executionCapsuleHash}</div>
          <div>Baseline Git evidence: {reviewRequest.baselineGitEvidenceHash}</div>
          <div>Final Git evidence: {reviewRequest.finalGitEvidenceHash}</div>
          <div>Verification results: {reviewRequest.verificationResultsHash}</div>
          <div>Artifact set: {reviewRequest.executionArtifactSetHash}</div>
          <div>Final branch / head: {reviewRequest.finalBranch || "n/a"} @ {reviewRequest.finalHead ? reviewRequest.finalHead.slice(0, 12) : "n/a"}</div>
        </div>
      </section>
      <section className="card span12">
        <h2>Verification Summary</h2>
        {verification.length ? <div className="stack">{verification.map(result => <div className="row" key={result.operation}><strong>{result.operation}</strong><span className={`pill ${result.passed ? "good" : "warn"}`}>{result.passed ? "PASSED" : "FAILED"}</span><span>{result.summary}</span></div>)}</div> : <p className="subtle">No Relay-owned verification result recorded for this execution.</p>}
      </section>
      <section className="card span12">
        <RelayV2ReviewLive reviewRequestId={reviewRequest.id} projectId={reviewRequest.projectId} initial={dto} initialInvocation={latestInvocation} />
      </section>
    </div>
  </>;
}
