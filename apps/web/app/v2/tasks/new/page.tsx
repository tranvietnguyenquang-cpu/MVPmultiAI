import Link from "next/link";
import { notFound } from "next/navigation";
import { RelayV2ManualTaskForm } from "../../../../components/relay-v2/manual-task-form";
import { getRelayV2Orchestrator, isRelayV2Enabled } from "../../../../lib/relay-v2/server";

export const dynamic = "force-dynamic";
export default async function RelayV2NewTaskPage() {
  if (!isRelayV2Enabled()) notFound();
  const projects = await (await getRelayV2Orchestrator()).listProjects();
  return <><div className="eyebrow">Relay v2 / Create Task</div><h1>Manual task</h1>{projects.length ? <div className="grid"><section className="card span8"><RelayV2ManualTaskForm projects={projects.map(project => ({ id: project.id, name: project.name }))}/></section><section className="card span4"><h2>Controlled outcome</h2><p className="subtle">The task is normalized, hashed, audited, and stored as PENDING_APPROVAL. Approval is a separate screen and still does not execute it.</p></section></div> : <div className="empty">Create a <Link href="/v2/projects/new">Relay v2 project</Link> first.</div>}</>;
}
