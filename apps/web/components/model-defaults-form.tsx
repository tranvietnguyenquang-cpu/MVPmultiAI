"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { csrfFetch } from "../lib/csrf-client";

type ModelChoice = { modelId: string; displayName: string };

export function ModelDefaultsForm({
  endpoint,
  initial,
  claudeModels,
  codexModels,
  codexReasoningEfforts,
}: {
  endpoint: string;
  initial: { defaultClaudeModel: string | null; defaultCodexModel: string | null; defaultCodexReasoningEffort: string | null };
  claudeModels: ModelChoice[];
  codexModels: ModelChoice[];
  codexReasoningEfforts: string[];
}) {
  const router = useRouter();
  const [claudeModel, setClaudeModel] = useState(initial.defaultClaudeModel ?? "");
  const [codexModel, setCodexModel] = useState(initial.defaultCodexModel ?? "");
  const [codexEffort, setCodexEffort] = useState(initial.defaultCodexReasoningEffort ?? "");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const response = await csrfFetch(endpoint, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          defaultClaudeModel: claudeModel || null,
          defaultCodexModel: codexModel || null,
          defaultCodexReasoningEffort: codexEffort || null,
        }),
      });
      const data = await response.json() as { error?: string };
      setMessage(response.ok ? "Saved." : data.error ?? "Could not save model defaults.");
      if (response.ok) router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="form" onSubmit={save}>
      <div className="two">
        <label>
          Default Claude model
          <select value={claudeModel} onChange={event => setClaudeModel(event.target.value)} disabled={busy}>
            <option value="">Default</option>
            {claudeModels.map(item => <option key={item.modelId} value={item.modelId}>{item.displayName}</option>)}
          </select>
        </label>
        <label>
          Default Codex model
          <select value={codexModel} onChange={event => setCodexModel(event.target.value)} disabled={busy}>
            <option value="">Default</option>
            {codexModels.map(item => <option key={item.modelId} value={item.modelId}>{item.displayName}</option>)}
          </select>
        </label>
      </div>
      <label>
        Default Codex reasoning effort
        <select value={codexEffort} onChange={event => setCodexEffort(event.target.value)} disabled={busy}>
          <option value="">Default</option>
          {codexReasoningEfforts.map(effort => <option key={effort} value={effort}>{effort}</option>)}
        </select>
      </label>
      {message && <p className="subtle">{message}</p>}
      <button disabled={busy}>{busy ? "Saving…" : "Save model defaults"}</button>
    </form>
  );
}
