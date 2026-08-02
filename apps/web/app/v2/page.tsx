import Link from "next/link";
import { notFound } from "next/navigation";
import { getRelayV2Orchestrator, isRelayV2Enabled } from "../../lib/relay-v2/server";

export const dynamic = "force-dynamic";

export default async function RelayV2Dashboard() {
  if (!isRelayV2Enabled()) notFound();
  const orchestrator = await getRelayV2Orchestrator();
  const [projects, tasks] = await Promise.all([orchestrator.listProjects(), orchestrator.listTasks()]);
  const pending = tasks.filter(task => task.status === "PENDING_APPROVAL");
  return <><div className="eyebrow">Relay v2 / local task control plane</div><h1>Approval before execution.</h1><p className="subtle">Milestone 1 accepts structured work, validates it, and stops at approval. No v2 action can start an agent.</p><div className="grid"><section className="card span4"><div className="label">Projects</div><div className="metric">{projects.length}</div><Link className="button secondary" href="/v2/projects">Manage projects</Link></section><section className="card span4"><div className="label">Pending approval</div><div className="metric">{pending.length}</div><Link className="button" href="/v2/tasks">Open inbox</Link></section><section className="card span4"><div className="label">Execution</div><div className="metric good">Disabled</div><p className="subtle">Milestone 1 has no queue or provider process.</p></section><section className="card span6"><h2>Create task</h2><p className="subtle">Create a task manually with normalized constraints and acceptance criteria.</p><Link className="button" href="/v2/tasks/new">Create task</Link></section><section className="card span6"><h2>Import handoff</h2><p className="subtle">Validate pasted, clipboard, YAML, or JSON handoffs before persistence.</p><Link className="button" href="/v2/import">Import handoff</Link></section></div></>;
}
