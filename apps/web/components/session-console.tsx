"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

export function SessionConsole({ taskId, sessionId: initialSession }: { taskId: string; sessionId?: string | undefined }) {
  const router = useRouter();
  const [sessionId, setSessionId] = useState(initialSession);
  const [logs, setLogs] = useState<string[]>([]);
  const [state, setState] = useState(initialSession ? "CONNECTING" : "IDLE");
  const source = useRef<EventSource | undefined>(undefined);
  useEffect(() => {
    if (!sessionId) return;
    const events = new EventSource(`/api/sessions/${sessionId}/events`);
    source.current = events;
    for (const type of ["stdout", "stderr", "state"]) events.addEventListener(type, (event) => {
      const data = JSON.parse((event as MessageEvent).data) as { message: string };
      setLogs((old) => [...old, data.message].slice(-500));
    });
    events.addEventListener("done", (event) => {
      const data = JSON.parse((event as MessageEvent).data) as { state: string };
      setState(data.state); events.close(); router.refresh();
    });
    events.onerror = () => setState("RECONNECTING");
    return () => events.close();
  }, [sessionId, router]);
  async function start() {
    setState("QUEUING");
    const response = await fetch("/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskId }) });
    const data = await response.json() as { id?: string; error?: string };
    if (!response.ok) { setState(data.error ?? "FAILED"); return; }
    setSessionId(data.id); setState("QUEUED");
  }
  async function cancel() {
    if (!sessionId) return;
    await fetch(`/api/sessions/${sessionId}/cancel`, { method: "POST" });
    setState("CANCELLED"); source.current?.close();
  }
  return <div className="stack"><div className="row"><span className="pill">{state}</span><div>{sessionId && !["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT"].includes(state) && <button className="button secondary" onClick={cancel}>Cancel</button>} {!sessionId && <button onClick={start}>Start Codex session</button>}</div></div><div className="log mono">{logs.length ? logs.join("") : "Session events will appear here. Logs are truncated and likely secrets are redacted."}</div></div>;
}
