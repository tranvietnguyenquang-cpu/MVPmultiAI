"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { relayV2Fetch } from "../../lib/relay-v2/client";

type LiveEvent = { sequence: number; eventType: string; level: string; message: string; createdAt: string };

export function RelayV2ExecutionLiveEvents({ sessionId, projectId, initialEvents, terminal }: { sessionId: string; projectId: string; initialEvents: LiveEvent[]; terminal: boolean }) {
  const router = useRouter();
  const [events, setEvents] = useState(initialEvents);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const cursor = useRef(initialEvents.at(-1)?.sequence ?? 0);
  const reconnectFailures = useRef(0);
  const completed = useRef(terminal);
  useEffect(() => {
    if (terminal) return;
    completed.current = false;
    const source = new EventSource(`/api/v2/executions/${sessionId}/events?projectId=${encodeURIComponent(projectId)}&cursor=${cursor.current}`);
    source.addEventListener("execution", raw => {
      const event = JSON.parse((raw as MessageEvent).data) as LiveEvent;
      if (event.sequence <= cursor.current) return;
      cursor.current = event.sequence;
      setEvents(current => [...current, event]);
    });
    source.addEventListener("complete", () => {
      completed.current = true;
      source.close();
      setError("");
      router.refresh();
    });
    source.onopen = () => {
      reconnectFailures.current = 0;
      setError("");
    };
    source.onerror = () => {
      if (completed.current) return;
      reconnectFailures.current += 1;
      if (reconnectFailures.current >= 2) setError("Reconnecting to persisted execution events...");
      // Native EventSource reconnects and supplies Last-Event-ID. Do not close it here.
    };
    return () => source.close();
  }, [projectId, router, sessionId, terminal]);

  async function cancel() {
    setBusy(true); setError("");
    try {
      const response = await relayV2Fetch(`/api/v2/executions/${sessionId}/cancel?projectId=${encodeURIComponent(projectId)}`, { method: "POST" });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Could not cancel execution.");
      router.refresh();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not cancel execution."); }
    finally { setBusy(false); }
  }

  return <div className="stack">
    {!terminal ? <button className="button secondary" disabled={busy} onClick={cancel}>Cancel Execution</button> : null}
    {error ? <p className="warn">{error}</p> : null}
    <div className="stack mono" aria-label="Execution live logs">{events.map(event => <div key={event.sequence} className="row"><span>#{event.sequence} {event.eventType}</span><span className={`pill ${event.level === "ERROR" ? "warn" : event.level === "WARNING" ? "warn" : ""}`}>{event.level}</span><span>{event.message}</span></div>)}</div>
  </div>;
}
