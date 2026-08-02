import Link from "next/link";
import { notFound } from "next/navigation";
import { RelayV2ExecutionActions } from "../../../../components/relay-v2/execution-actions";
import { RelayV2TaskActions } from "../../../../components/relay-v2/task-actions";
import { RelayV2TaskEditForm } from "../../../../components/relay-v2/task-edit-form";
import { getRelayV2ExecutionServices, getRelayV2Orchestrator, isRelayV2Enabled } from "../../../../lib/relay-v2/server";

export const dynamic = "force-dynamic";
export default async function RelayV2TaskDetailPage({ params }: { params: Promise<{ id: string }> }) {
  if (!isRelayV2Enabled()) notFound();
  const orchestrator = await getRelayV2Orchestrator();
  const task = await orchestrator.getTask((await params).id);
  if (!task) notFound();
  const [audit, sessions] = await Promise.all([
    orchestrator.listTaskAudit(task.id),
    getRelayV2ExecutionServices().then(services => services.engine.listSessions(task.projectId))
  ]);
  const execution = sessions.find(session => session.taskId === task.id);
  const approval = task.approvals.find(item => item.status === "APPROVED" && item.specHash === task.specHash);
  return <><div className="eyebrow">Relay v2 / {task.project.name} / Task</div><h1>{task.title}</h1><div className="row"><p className="subtle">{task.objective}</p><span className={`pill ${task.status === "PENDING_APPROVAL" ? "warn" : task.status === "APPROVED" ? "good" : ""}`}>{task.status}</span></div><div className="grid">
    <section className="card span8"><h2>Specification</h2><p>{task.context || "No additional context."}</p><div className="two"><div><h3>Constraints</h3><ul>{task.constraints.map(item => <li key={item.id}>{item.text}</li>)}</ul></div><div><h3>Acceptance criteria</h3><ul>{task.acceptanceCriteria.map(item => <li key={item.id}>{item.description}</li>)}</ul></div></div><RelayV2TaskEditForm taskId={task.id} normalizedSpecJson={task.normalizedSpecJson}/></section>
    <section className="card span4"><h2>Selection</h2><div className="stack mono"><div className="row"><span>Executor</span><span>{task.selectedExecutor}</span></div><div className="row"><span>Model</span><span>{task.selectedModel}</span></div><div className="row"><span>Effort</span><span>{task.selectedEffort}</span></div><div className="row"><span>Reviewer</span><span>{task.reviewer}</span></div><div className="row"><span>Spec hash</span><span>{task.specHash.slice(0, 12)}...</span></div></div><div className="divider"/><RelayV2TaskActions taskId={task.id} status={task.status}/>{task.status === "PENDING_APPROVAL" ? <Link className="button secondary" href={`/v2/tasks/${task.id}/approval`}>Open approval view</Link> : null}<div className="divider"/><h3>Execution approval snapshot</h3>{approval ? <div className="stack mono"><div>{approval.executor} / {approval.model}</div><div>{approval.effort} / reviewer {approval.reviewer}</div><div>{approval.specHash.slice(0, 12)}...</div></div> : <p className="subtle">No current approved snapshot.</p>}<RelayV2ExecutionActions taskId={task.id} projectId={task.projectId} status={task.status} {...(execution ? { sessionId: execution.id } : {})}/></section>
    <section className="card span12"><h2>Task audit history</h2><div className="stack">{audit.map(event => <div className="row" key={event.id}><div><strong>{event.action}</strong><div className="mono subtle">{event.createdAt.toLocaleString()} · {event.actor}</div></div><span className="pill">{event.riskLevel}</span></div>)}</div></section>
  </div></>;
}
