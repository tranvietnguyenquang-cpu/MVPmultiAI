"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { relayV2Fetch } from "../../lib/relay-v2/client";

type ProjectOption = { id: string; name: string };

export function RelayV2ManualTaskForm({ projects }: { projects: ProjectOption[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    const project = projects.find(item => item.id === form.get("projectId"));
    if (!project) { setError("Select a project."); setBusy(false); return; }
    const lines = (name: string) => String(form.get(name) ?? "").split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    const handoff = {
      version: 1,
      project: { name: project.name },
      task: {
        title: form.get("title"), objective: form.get("objective"), taskType: form.get("taskType"),
        complexity: form.get("complexity"), context: form.get("context")
      },
      constraints: lines("constraints"),
      acceptanceCriteria: lines("acceptanceCriteria"),
      execution: {
        executor: form.get("executor"), model: form.get("model") || "auto", effort: form.get("effort"),
        reviewer: form.get("reviewer"), requireApproval: true, allowSourceTransmissionToApi: false
      }
    };
    try {
      const validation = await relayV2Fetch("/api/v2/handoffs/validate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: JSON.stringify(handoff), format: "JSON", projectId: project.id }) });
      const checked = await validation.json() as { normalized?: unknown; error?: string; issues?: Array<{ path: string; message: string }> };
      if (!validation.ok || !checked.normalized) throw new Error(checked.issues?.map(issue => `${issue.path}: ${issue.message}`).join("\n") || checked.error || "Task validation failed.");
      const response = await relayV2Fetch("/api/v2/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: project.id, normalized: checked.normalized, source: "MANUAL", idempotencyKey: crypto.randomUUID() }) });
      const created = await response.json() as { task?: { id: string; status: string }; error?: string };
      if (!response.ok || !created.task) throw new Error(created.error ?? "Task creation failed.");
      if (created.task.status !== "PENDING_APPROVAL") throw new Error("Relay refused an unexpected task status.");
      router.push(`/v2/tasks/${created.task.id}`);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Task creation failed.");
    } finally {
      setBusy(false);
    }
  }

  return <form className="form" onSubmit={submit}>
    <label>Project<select name="projectId" required defaultValue=""><option value="" disabled>Select a project</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
    <div className="two"><label>Title<input name="title" required maxLength={200}/></label><label>Task type<select name="taskType" defaultValue="implementation"><option value="implementation">Implementation</option><option value="bugfix">Bug fix</option><option value="documentation">Documentation</option><option value="analysis">Analysis</option><option value="migration">Migration</option><option value="security">Security</option><option value="operations">Operations</option><option value="other">Other</option></select></label></div>
    <label>Objective<textarea name="objective" required/></label>
    <label>Context<textarea name="context"/></label>
    <div className="two"><label>Complexity<select name="complexity" defaultValue="normal"><option value="trivial">Trivial</option><option value="normal">Normal</option><option value="complex">Complex</option><option value="critical">Critical</option></select></label><label>Executor<select name="executor" defaultValue="codex"><option value="auto">Auto</option><option value="codex">Codex</option><option value="claude">Claude</option></select></label></div>
    <div className="two"><label>Model<input name="model" defaultValue="auto"/></label><label>Effort<select name="effort" defaultValue="auto"><option value="auto">Auto</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label></div>
    <label>Reviewer<select name="reviewer" defaultValue="claude"><option value="none">None</option><option value="auto">Auto</option><option value="codex">Codex</option><option value="claude">Claude</option></select></label>
    <div className="two"><label>Constraints, one per line<textarea name="constraints"/></label><label>Acceptance criteria, one per line<textarea name="acceptanceCriteria" required/></label></div>
    <p className="subtle">Creation always ends at PENDING_APPROVAL. No provider is contacted.</p>
    {error ? <pre className="warn">{error}</pre> : null}
    <button disabled={!hydrated || busy}>{busy ? "Creating..." : "Create pending task"}</button>
  </form>;
}
