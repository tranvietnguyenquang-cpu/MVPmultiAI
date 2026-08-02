"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { relayV2Fetch } from "../../lib/relay-v2/client";

export function RelayV2TaskEditForm({ taskId, normalizedSpecJson }: { taskId: string; normalizedSpecJson: string }) {
  const router = useRouter();
  const [text, setText] = useState(() => JSON.stringify(JSON.parse(normalizedSpecJson) as unknown, null, 2));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true); setError("");
    try {
      const normalized = JSON.parse(text) as unknown;
      const response = await relayV2Fetch(`/api/v2/tasks/${taskId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ normalized }) });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Could not update task.");
      router.refresh();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not update task."); }
    finally { setBusy(false); }
  }
  return <details><summary>Edit normalized task specification</summary><div className="form"><textarea className="mono" style={{ minHeight: 360 }} value={text} onChange={event => setText(event.target.value)}/><p className="subtle">Changing an approved task invalidates its approval and returns it to PENDING_APPROVAL.</p>{error ? <p className="warn">{error}</p> : null}<button type="button" disabled={busy} onClick={save}>{busy ? "Saving..." : "Save and require approval"}</button></div></details>;
}
