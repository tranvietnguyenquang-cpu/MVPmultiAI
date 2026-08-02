import Link from "next/link";
import { notFound } from "next/navigation";
import { getRelayV2Orchestrator, isRelayV2Enabled } from "../../../lib/relay-v2/server";

export const dynamic = "force-dynamic";
export default async function RelayV2TaskInboxPage() {
  if (!isRelayV2Enabled()) notFound();
  const tasks = await (await getRelayV2Orchestrator()).listTasks();
  return <><div className="eyebrow">Relay v2 / Task Inbox</div><h1>Task inbox</h1><div className="row"><p className="subtle">New tasks wait for local review. Approval never starts execution in Milestone 1.</p><div><Link className="button" href="/v2/tasks/new">Create task</Link> <Link className="button secondary" href="/v2/import">Import handoff</Link></div></div><div className="stack" style={{ marginTop: 28 }}>{tasks.length ? tasks.map(task => <Link key={task.id} className="card" href={`/v2/tasks/${task.id}`}><div className="row"><div><h2>{task.title}</h2><p className="subtle">{task.project.name} · {task.taskType} · {task.complexity}</p></div><span className={`pill ${task.status === "PENDING_APPROVAL" ? "warn" : task.status === "APPROVED" ? "good" : ""}`}>{task.status}</span></div></Link>) : <div className="empty">No Relay v2 tasks.</div>}</div></>;
}
