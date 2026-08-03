"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { relayV2Fetch } from "../../lib/relay-v2/client";

type WorkspacePreview = { evidenceHash: string; branch: string; head: string; dirty: boolean; stagedCount: number; unstagedCount: number; untrackedCount: number; status: Array<{ path: string; indexStatus: string; worktreeStatus: string }> };

export function RelayV2ExecutionActions({ taskId, status, selectedExecutor, sessionId, projectId }: { taskId: string; status: string; selectedExecutor: string; sessionId?: string; projectId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [scenario, setScenario] = useState<"success" | "failure" | "timeout" | "cancellation">("success");
  const [workspace, setWorkspace] = useState<WorkspacePreview>();
  const [dirtyAcknowledged, setDirtyAcknowledged] = useState(false);
  async function inspectWorkspace() {
    setBusy(true); setError("");
    try {
      const response = await relayV2Fetch(`/api/v2/projects/${projectId}/workspace-evidence`);
      const result = await response.json() as WorkspacePreview & { error?: string };
      if (!response.ok || !result.evidenceHash) throw new Error(result.error ?? "Could not inspect the Git baseline.");
      setWorkspace(result); setDirtyAcknowledged(false);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not inspect the Git baseline."); }
    finally { setBusy(false); }
  }
  async function requestExecution() {
    setBusy(true); setError("");
    try {
      const body = selectedExecutor === "CODEX"
        ? { ...(workspace?.dirty && dirtyAcknowledged ? { dirtyBaselineAcknowledgedHash: workspace.evidenceHash } : {}) }
        : { fakeScenario: { outcome: scenario, delayMs: 1, eventCount: 3 } };
      const response = await relayV2Fetch(`/api/v2/tasks/${taskId}/executions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json() as { error?: string; session?: { id: string } };
      if (!response.ok || !result.session) throw new Error(result.error ?? "Could not request execution.");
      router.push(`/v2/executions/${result.session.id}?projectId=${projectId}`);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not request execution."); }
    finally { setBusy(false); }
  }
  return <div className="stack">
    {status === "APPROVED" && selectedExecutor === "FAKE" ? <><label>Fake scenario<select aria-label="Fake executor scenario" value={scenario} onChange={event => setScenario(event.target.value as typeof scenario)}><option value="success">Success</option><option value="failure">Failure</option><option value="timeout">Timeout</option><option value="cancellation">Cancellation</option></select></label><button disabled={busy} onClick={requestExecution}>Request Fake Execution</button></> : null}
    {status === "APPROVED" && selectedExecutor === "CODEX" ? <><button className="secondary" disabled={busy} onClick={inspectWorkspace}>Inspect Git baseline</button>{workspace ? <div className="mono subtle"><div>{workspace.branch} @ {workspace.head.slice(0, 12)}</div><div>{workspace.dirty ? `DIRTY: ${workspace.stagedCount} staged, ${workspace.unstagedCount} unstaged, ${workspace.untrackedCount} untracked` : "CLEAN"}</div><div>Evidence: {workspace.evidenceHash.slice(0, 16)}...</div>{workspace.dirty ? <label><input type="checkbox" checked={dirtyAcknowledged} onChange={event => setDirtyAcknowledged(event.target.checked)}/> I acknowledge this exact pre-existing baseline.</label> : null}</div> : <p className="subtle">Inspect the current Git baseline before requesting Codex.</p>}<button disabled={busy || !workspace || (workspace.dirty && !dirtyAcknowledged)} onClick={requestExecution}>Request Codex Execution</button></> : null}
    {status === "APPROVED" && !["FAKE", "CODEX"].includes(selectedExecutor) ? <p className="warn">The approved executor is not available in Milestone 2.2.</p> : null}
    {sessionId ? <Link className="button secondary" href={`/v2/executions/${sessionId}?projectId=${projectId}`}>View Execution</Link> : null}
    {status !== "APPROVED" && !sessionId ? <p className="subtle">Execution requires a current approved task snapshot.</p> : null}
    {error ? <p className="warn">{error}</p> : null}
  </div>;
}
