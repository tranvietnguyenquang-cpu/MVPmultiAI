"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { relayV2Fetch } from "../../lib/relay-v2/client";

export function RelayV2ExecutionActions({ taskId, status, sessionId, projectId }: { taskId: string; status: string; sessionId?: string; projectId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [scenario, setScenario] = useState<"success" | "failure" | "timeout" | "cancellation">("success");
  async function requestExecution() {
    setBusy(true); setError("");
    try {
      const response = await relayV2Fetch(`/api/v2/tasks/${taskId}/executions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fakeScenario: { outcome: scenario, delayMs: 1, eventCount: 3 } }) });
      const result = await response.json() as { error?: string; session?: { id: string } };
      if (!response.ok || !result.session) throw new Error(result.error ?? "Could not request execution.");
      router.push(`/v2/executions/${result.session.id}`);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not request execution."); }
    finally { setBusy(false); }
  }
  return <div className="stack">
    {status === "APPROVED" ? <><label>Fake scenario<select aria-label="Fake executor scenario" value={scenario} onChange={event => setScenario(event.target.value as typeof scenario)}><option value="success">Success</option><option value="failure">Failure</option><option value="timeout">Timeout</option><option value="cancellation">Cancellation</option></select></label><button disabled={busy} onClick={requestExecution}>Request Execution</button></> : null}
    {sessionId ? <Link className="button secondary" href={`/v2/executions/${sessionId}?projectId=${projectId}`}>View Execution</Link> : null}
    {status !== "APPROVED" && !sessionId ? <p className="subtle">Execution requires a current approved task snapshot.</p> : null}
    {error ? <p className="warn">{error}</p> : null}
  </div>;
}
