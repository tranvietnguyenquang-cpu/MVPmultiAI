import Link from "next/link";
import { notFound } from "next/navigation";
import { getRelayV2ExecutionServices, isRelayV2ExecutionEnabled } from "../../../lib/relay-v2/server";

export const dynamic = "force-dynamic";
export default async function RelayV2ExecutionDashboard() {
  if (!isRelayV2ExecutionEnabled()) notFound();
  const { engine, runtime } = await getRelayV2ExecutionServices();
  runtime.start();
  const [sessions, leases, health] = await Promise.all([engine.listSessions(), engine.listWorkspaceLeases(), engine.executor.health()]);
  const descriptor = engine.executor.describe();
  return <><div className="eyebrow">Relay v2 / Execution</div><h1>Execution Dashboard</h1><p className="subtle">Durable SQLite work claims with one in-process, non-writing FakeExecutor.</p><div className="grid">
    <section className="card span4"><h2>Fake Executor Status</h2><div className="metric good">{health.healthy ? "Ready" : "Unavailable"}</div><p>{health.message}</p><p className="mono">{descriptor.id} · {descriptor.providerType}</p></section>
    <section className="card span4"><h2>Runtime</h2><div className="metric">{runtime.status().running ? "Polling" : "Stopped"}</div><p className="subtle">No provider, process, shell, or network executor is registered.</p></section>
    <section className="card span4"><h2>Workspace Lease Status</h2><div className="metric">{leases.filter(lease => !lease.releasedAt).length}</div><p className="subtle">active exclusive write leases</p></section>
    <section className="card span12"><h2>Execution Sessions</h2><div className="stack">{sessions.map(session => <Link className="row" key={session.id} href={`/v2/executions/${session.id}?projectId=${session.projectId}`}><div><strong>{session.task.title}</strong><div className="subtle">{session.project.name} · attempt {session.attempt}</div></div><span className={`pill ${session.status === "SUCCEEDED" ? "good" : ["FAILED","TIMED_OUT","BLOCKED"].includes(session.status) ? "warn" : ""}`}>{session.status}</span></Link>)}{!sessions.length ? <p className="subtle">No execution has been requested.</p> : null}</div></section>
    <section className="card span12"><h2>Lease History</h2><div className="stack mono">{leases.map(lease => <div className="row" key={lease.id}><span>{lease.session.project.name}</span><span>{lease.workspaceKey}</span><span className="pill">{lease.releasedAt ? "RELEASED" : "ACTIVE"}</span></div>)}{!leases.length ? <p className="subtle">No workspace leases recorded.</p> : null}</div></section>
  </div></>;
}
