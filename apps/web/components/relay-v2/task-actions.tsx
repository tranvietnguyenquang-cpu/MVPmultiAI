"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { relayV2Fetch } from "../../lib/relay-v2/client";

export function RelayV2TaskActions({ taskId, status }: { taskId: string; status: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function action(kind: "approve" | "cancel", rejected = false) {
    setBusy(true); setError("");
    try {
      const response = await relayV2Fetch(`/api/v2/tasks/${taskId}/${kind}`, { method: "POST", headers: { "content-type": "application/json" }, ...(kind === "cancel" ? { body: JSON.stringify({ rejected }) } : {}) });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? `Could not ${kind} task.`);
      router.refresh();
    } catch (caught) { setError(caught instanceof Error ? caught.message : `Could not ${kind} task.`); }
    finally { setBusy(false); }
  }

  return <div className="stack"><div className="row"><span className="pill">{status}</span><div>{status === "PENDING_APPROVAL" ? <><button disabled={busy} onClick={() => action("approve")}>Approve without executing</button> <button disabled={busy} className="button secondary" onClick={() => action("cancel", true)}>Reject</button></> : null}{["DRAFT", "APPROVED"].includes(status) ? <button disabled={busy} className="button secondary" onClick={() => action("cancel")}>Cancel task</button> : null}</div></div>{error ? <p className="warn">{error}</p> : null}</div>;
}
