"use client";

import { useState } from "react";
import { relayV2Fetch } from "../../lib/relay-v2/client";

type Snapshot = {
  version: string;
  displayPath: string;
  authenticationStatus: string;
  supported: boolean;
  execAvailable: boolean;
  modelFlag: boolean;
  reasoningEffortMechanism: string;
  sandboxModes: string[];
  approvalModes: string[];
  outputModes: string[];
  unsupportedReasons: string[];
  detectedAt: string;
};

export function RelayV2CodexDiagnostics({ initial }: { initial?: Snapshot }) {
  const [snapshot, setSnapshot] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function testConnection() {
    setBusy(true); setError("");
    try {
      const response = await relayV2Fetch("/api/v2/executors/codex/diagnostics", { method: "POST" });
      const result = await response.json() as { snapshot?: Snapshot; error?: string };
      if (!response.ok || !result.snapshot) throw new Error(result.error ?? "Codex diagnostics failed.");
      setSnapshot(result.snapshot);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Codex diagnostics failed."); }
    finally { setBusy(false); }
  }
  return <section className="card span12"><div className="row"><div><h2>Codex CLI diagnostics</h2><p className="subtle">Local capability discovery only. It does not execute a task or call the OpenAI API.</p></div><button type="button" disabled={busy} onClick={testConnection}>{busy ? "Inspecting..." : "Test connection"}</button></div>
    {snapshot ? <div className="grid"><div className="span4 stack mono"><div>Version: {snapshot.version || "unknown"}</div><div>Path: {snapshot.displayPath || "not found"}</div><div>Authentication: {snapshot.authenticationStatus}</div><div>Detected: {new Date(snapshot.detectedAt).toLocaleString()}</div></div><div className="span4 stack mono"><div>Exec: {snapshot.execAvailable ? "verified" : "unsupported"}</div><div>Model flag: {snapshot.modelFlag ? "verified" : "unknown"}</div><div>Effort: {snapshot.reasoningEffortMechanism}</div><div>Supported: {snapshot.supported ? "yes" : "no"}</div></div><div className="span4"><strong>Verified modes</strong><p className="mono">Sandbox: {snapshot.sandboxModes.join(", ") || "none"}<br/>Approval: {snapshot.approvalModes.join(", ") || "none"}<br/>Output: {snapshot.outputModes.join(", ") || "none"}</p>{snapshot.unsupportedReasons.map(reason => <p className="warn" key={reason}>{reason}</p>)}</div></div> : <p className="subtle">No persisted capability snapshot. Run Test connection.</p>}
    {error ? <p className="warn">{error}</p> : null}
  </section>;
}
