"use client";

import { useEffect, useState } from "react";
import { relayV2Fetch } from "../../lib/relay-v2/client";

type LegacyProject = { id: string; name: string; _count: { tasks: number; approvals: number } };

export function RelayV2LegacyPreview({ v2Projects }: { v2Projects: Array<{ id: string; name: string }> }) {
  const [legacy, setLegacy] = useState<LegacyProject[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [v2ProjectId, setV2ProjectId] = useState(v2Projects[0]?.id ?? "");
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { void fetch("/api/v2/legacy/report").then(async response => { const body = await response.json() as LegacyProject[] & { error?: string }; if (!response.ok) throw new Error(body.error ?? "Legacy database is unavailable."); setLegacy(body); }).catch(caught => setError(caught instanceof Error ? caught.message : "Legacy database is unavailable.")); }, []);
  async function preview() {
    setError(""); setResult(null);
    try {
      const response = await relayV2Fetch("/api/v2/legacy/report", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ v2ProjectId, legacyProjectIds: selected }) });
      const body = await response.json() as Record<string, unknown> & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not create the report.");
      setResult(body);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not create the report."); }
  }
  return <div className="grid"><section className="card span6"><h2>Legacy PostgreSQL selection</h2><p className="subtle">Read-only preview. No rows are imported or changed.</p><div className="form"><label>Attach report to v2 project<select value={v2ProjectId} onChange={event => setV2ProjectId(event.target.value)}>{v2Projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>{legacy.map(project => <label key={project.id} className="row"><span>{project.name} ({project._count.tasks} tasks, {project._count.approvals} approvals)</span><input style={{ width: "auto" }} type="checkbox" checked={selected.includes(project.id)} onChange={event => setSelected(current => event.target.checked ? [...current, project.id] : current.filter(id => id !== project.id))}/></label>)}<button type="button" disabled={!v2ProjectId || !selected.length} onClick={preview}>Generate read-only report</button>{error ? <p className="warn">{error}</p> : null}</div></section><section className="card span6"><h2>Report</h2>{result ? <><span className="pill good">PREVIEW ONLY</span><pre className="log">{JSON.stringify(result, null, 2)}</pre></> : <div className="empty">Select legacy projects to calculate candidates and explicit skip reasons.</div>}</section></div>;
}
