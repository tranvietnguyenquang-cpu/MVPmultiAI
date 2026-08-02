import { notFound } from "next/navigation";
import { executionStatusSchema, isTerminalExecutionStatus } from "@project-relay/relay-v2-domain";
import { RelayV2ExecutionLiveEvents } from "../../../../components/relay-v2/execution-live-events";
import { getRelayV2ExecutionServices, isRelayV2ExecutionEnabled } from "../../../../lib/relay-v2/server";

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
  return <><div className="eyebrow">Relay v2 / Execution / {session.project.name}</div><div className="row"><h1>{session.task.title}</h1><span className={`pill ${session.status === "SUCCEEDED" ? "good" : ["FAILED","TIMED_OUT","BLOCKED"].includes(session.status) ? "warn" : ""}`}>{session.status}</span></div><div className="grid">
    <section className="card span8"><h2>Live Logs</h2><RelayV2ExecutionLiveEvents sessionId={session.id} projectId={session.projectId} terminal={terminal} initialEvents={session.events.map(event => ({ sequence: event.sequence, eventType: event.eventType, level: event.level, message: event.message, createdAt: event.createdAt.toISOString() }))}/></section>
    <section className="card span4"><h2>Approved Snapshot</h2><div className="stack mono"><div>Executor: {session.executorId}</div><div>Approved executor: {session.approvedExecutor}</div><div>Model: {session.approvedModel}</div><div>Effort: {session.approvedEffort}</div><div>Reviewer: {session.approvedReviewer}</div><div>Spec: {session.approvedSpecHash.slice(0, 12)}...</div><div>Attempt: {session.attempt}</div></div><div className="divider"/><h3>Workspace Lease</h3><p className="mono">{currentLease ? `ACTIVE until ${currentLease.expiresAt.toLocaleString()}` : session.leases.length ? "RELEASED" : "NOT CLAIMED"}</p></section>
    <section className="card span12"><h2>Timeline</h2><div className="stack">{timeline.map((event, index) => <div className="row" key={`${event.kind}-${event.sequence ?? index}`}><div><strong>{event.type}</strong><div className="subtle">{event.at.toLocaleString()} · {event.kind}</div></div><span className="pill">{event.level}</span><span>{event.message}</span></div>)}</div></section>
    <section className="card span6"><h2>Result</h2><p>{session.summary || "No terminal result yet."}</p>{session.failureCode ? <p className="warn mono">{session.failureCode}: {session.failureMessage}</p> : null}<p className="subtle">Duration: {session.durationMs === null ? "pending" : `${session.durationMs} ms`}</p></section>
    <section className="card span6"><h2>Artifacts</h2><div className="stack mono">{session.artifacts.map(artifact => <div key={artifact.id}><strong>{artifact.artifactType}</strong><div>{artifact.relativePath}</div><div>{artifact.byteCount} bytes · sha256 {artifact.sha256.slice(0, 16)}...{artifact.truncated ? " · truncated" : ""}</div></div>)}{!session.artifacts.length ? <p className="subtle">Artifacts are finalized when execution reaches a terminal state.</p> : null}</div></section>
  </div></>;
}
