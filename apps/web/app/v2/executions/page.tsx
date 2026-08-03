import Link from "next/link";
import { notFound } from "next/navigation";
import { getRelayV2ExecutionServices, isRelayV2ExecutionEnabled } from "../../../lib/relay-v2/server";

export const dynamic = "force-dynamic";
export default async function RelayV2ExecutionDashboard() {
  if (!isRelayV2ExecutionEnabled()) notFound();
  const { engine, runtime } = await getRelayV2ExecutionServices();
  runtime.start();
  const [sessions, leases, fakeHealth, codexSnapshot] = await Promise.all([
    engine.listSessions(), engine.listWorkspaceLeases(), engine.executor.health(), engine.latestExecutorCapability("codex-cli")
  ]);
  return <><div className="eyebrow">Relay v2 / Execution</div><h1>Execution Dashboard</h1><p className="subtle">Durable SQLite work claims for FakeExecutor and the approval-bound local Codex CLI executor.</p><div className="grid">
    <section className="card span4"><h2>Fake Executor Status</h2><div className="metric good">{fakeHealth.healthy ? "Ready" : "Unavailable"}</div><p>{fakeHealth.message}</p></section>
    <section className="card span4"><h2>Runtime</h2><div className="metric">{runtime.status().running ? "Polling" : "Stopped"}</div><p className="subtle">Only the execution runtime can invoke the local Codex CLI boundary.</p></section>
    <section className="card span4"><h2>Workspace Lease Status</h2><div className="metric">{leases.filter(lease => !lease.releasedAt).length}</div><p className="subtle">active exclusive write leases</p></section>
    <section className="card span12"><div className="row"><div><h2>Codex CLI Status</h2><p className="subtle">{codexSnapshot ? `${codexSnapshot.version || "Unknown version"} · ${codexSnapshot.authenticationStatus}` : "Not inspected yet"}</p></div><Link className="button secondary" href="/v2/executors/codex">Open diagnostics</Link></div></section>
    <section className="card span12"><h2>Execution Sessions</h2><div className="stack">{sessions.map(session => <Link className="row" key={session.id} href={`/v2/executions/${session.id}?projectId=${session.projectId}`}><div><strong>{session.task.title}</strong><div className="subtle">{session.project.name} · {session.executorId} · attempt {session.attempt}</div></div><span className={`pill ${session.status === "SUCCEEDED" ? "good" : ["FAILED", "TIMED_OUT", "BLOCKED"].includes(session.status) ? "warn" : ""}`}>{session.status}</span></Link>)}{!sessions.length ? <p className="subtle">No execution has been requested.</p> : null}</div></section>
    <section className="card span12"><h2>Lease History</h2><div className="stack mono">{leases.map(lease => <div className="row" key={lease.id}><span>{lease.session.project.name}</span><span>{lease.workspaceKey}</span><span className="pill">{lease.releasedAt ? "RELEASED" : "ACTIVE"}</span></div>)}{!leases.length ? <p className="subtle">No workspace leases recorded.</p> : null}</div></section>
  </div></>;
}
