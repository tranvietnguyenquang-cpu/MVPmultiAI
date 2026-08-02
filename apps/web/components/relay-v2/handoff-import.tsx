"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { relayV2Fetch } from "../../lib/relay-v2/client";

type Preview = { format: "JSON" | "YAML"; normalized: Record<string, unknown>; specHash: string };
type ProjectOption = { id: string; name: string };

export function RelayV2HandoffImport({ projects, template }: { projects: ProjectOption[]; template: string }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [source, setSource] = useState<"PASTE" | "CLIPBOARD" | "FILE_IMPORT">("PASTE");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function readClipboard() {
    setError("");
    if (!navigator.clipboard?.readText) { setError("Clipboard access is unavailable. Paste into the text area instead."); return; }
    try {
      const value = await navigator.clipboard.readText();
      if (!value) throw new Error("The clipboard is empty.");
      setText(value); setSource("CLIPBOARD"); setPreview(null);
    } catch (caught) {
      setError(`${caught instanceof Error ? caught.message : "Clipboard permission was denied."} Paste into the text area instead.`);
    }
  }

  async function loadFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!/\.(ya?ml|json)$/i.test(file.name)) { setError("Choose a .yaml, .yml, or .json file."); return; }
    if (file.size > 256 * 1024) { setError("The handoff file exceeds the 262144-byte limit."); return; }
    setText(await file.text()); setSource("FILE_IMPORT"); setPreview(null); setError("");
  }

  async function validate() {
    setBusy(true); setError(""); setPreview(null);
    try {
      const response = await relayV2Fetch("/api/v2/handoffs/validate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, format: "AUTO", ...(projectId ? { projectId } : {}) }) });
      const result = await response.json() as Preview & { error?: string; issues?: Array<{ path: string; message: string }> };
      if (!response.ok) throw new Error(result.issues?.map(issue => `${issue.path}: ${issue.message}`).join("\n") || result.error || "Validation failed.");
      setPreview(result);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Validation failed.");
    } finally { setBusy(false); }
  }

  async function createTask() {
    if (!preview || !projectId) return;
    setBusy(true); setError("");
    const normalizedSource = source === "CLIPBOARD" ? "CLIPBOARD" : source === "FILE_IMPORT" ? "FILE_IMPORT" : preview.format === "JSON" ? "HANDOFF_JSON" : "HANDOFF_YAML";
    try {
      const response = await relayV2Fetch("/api/v2/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId, normalized: preview.normalized, source: normalizedSource, idempotencyKey: preview.specHash }) });
      const result = await response.json() as { task?: { id: string; status: string }; error?: string };
      if (!response.ok || !result.task) throw new Error(result.error ?? "Task creation failed.");
      if (result.task.status !== "PENDING_APPROVAL") throw new Error("Relay refused an unexpected task status.");
      router.push(`/v2/tasks/${result.task.id}`); router.refresh();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Task creation failed."); }
    finally { setBusy(false); }
  }

  async function copyTemplate() {
    try { await navigator.clipboard.writeText(template); setError(""); }
    catch { setText(template); setError("Clipboard write is unavailable. The template was placed in the text area instead."); }
  }

  return <div className="grid">
    <section className="card span6"><h2>Paste or import Relay Handoff</h2><div className="form">
      <label>Target project<select value={projectId} onChange={event => setProjectId(event.target.value)}><option value="">Select a project</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
      <label>YAML or JSON<textarea value={text} onChange={event => { setText(event.target.value); setSource("PASTE"); setPreview(null); }} className="mono" style={{ minHeight: 320 }}/></label>
      <div className="row"><button type="button" className="button secondary" onClick={readClipboard}>Import from clipboard</button><label className="button secondary">Import file<input hidden type="file" accept=".yaml,.yml,.json,application/json,text/yaml" onChange={loadFile}/></label><button type="button" className="button secondary" onClick={copyTemplate}>Copy template</button></div>
      <button type="button" onClick={validate} disabled={busy || !text.trim()}>{busy ? "Working..." : "Validate and preview"}</button>
      {error ? <pre className="warn">{error}</pre> : null}
    </div></section>
    <section className="card span6"><h2>Handoff Preview</h2>{preview ? <div className="stack"><div className="row"><span className="pill good">VALID {preview.format}</span><span className="mono subtle">{preview.specHash.slice(0, 16)}...</span></div><pre className="log" style={{ maxHeight: 520 }}>{JSON.stringify(preview.normalized, null, 2)}</pre><button onClick={createTask} disabled={busy || !projectId}>Create PENDING_APPROVAL task</button><p className="subtle">This action stores the task and approval request only. It cannot queue execution.</p></div> : <div className="empty">Validate a handoff to preview its normalized, hashed task specification.</div>}</section>
  </div>;
}
