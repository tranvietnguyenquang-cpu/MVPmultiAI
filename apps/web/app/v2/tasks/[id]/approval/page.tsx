import { notFound } from "next/navigation";
import { RelayV2TaskActions } from "../../../../../components/relay-v2/task-actions";
import { getRelayV2Orchestrator, isRelayV2Enabled } from "../../../../../lib/relay-v2/server";

export const dynamic = "force-dynamic";
export default async function RelayV2ApprovalPage({ params }: { params: Promise<{ id: string }> }) {
  if (!isRelayV2Enabled()) notFound();
  const task = await (await getRelayV2Orchestrator()).getTask((await params).id);
  if (!task) notFound();
  const approval = task.approvals.find(item => item.status === "PENDING" && item.specHash === task.specHash) ?? task.approvals[0];
  return <><div className="eyebrow">Relay v2 / Approval</div><h1>Review exact task snapshot</h1><p className="subtle">Approval records this hash and selection. Milestone 1 has no execution queue, so approval stops at APPROVED.</p><div className="grid"><section className="card span7"><h2>{task.title}</h2><p>{task.objective}</p><pre className="log">{JSON.stringify(JSON.parse(task.normalizedSpecJson) as unknown, null, 2)}</pre></section><section className="card span5"><h2>Approval snapshot</h2><div className="stack mono"><div className="row"><span>Status</span><span>{approval?.status ?? "MISSING"}</span></div><div className="row"><span>Spec hash</span><span>{task.specHash.slice(0, 16)}...</span></div><div className="row"><span>Executor</span><span>{task.selectedExecutor}</span></div><div className="row"><span>Model</span><span>{task.selectedModel}</span></div><div className="row"><span>Effort</span><span>{task.selectedEffort}</span></div><div className="row"><span>Reviewer</span><span>{task.reviewer}</span></div><div className="row"><span>Permissions</span><span>{task.permissions.length}</span></div></div><div className="divider"/><RelayV2TaskActions taskId={task.id} status={task.status}/><p className="subtle">No code, queue job, provider session, Git mutation, or process is created by these actions.</p></section></div></>;
}
