"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { csrfFetch } from "../lib/csrf-client";

export function ConversationForm({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      const response = await csrfFetch(`/api/projects/${projectId}/conversations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: form.get("title") })
      });
      const data = await response.json() as { id?: string; error?: string };
      if (!response.ok) throw new Error(data.error ?? "Could not create conversation.");
      router.push(`/projects/${projectId}/conversations/${data.id!}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create conversation.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="form" onSubmit={submit}>
      <label>Conversation title<input name="title" required maxLength={200} placeholder="e.g. Add password reset flow" /></label>
      {error && <p className="warn">{error}</p>}
      <button disabled={busy}>{busy ? "Creating…" : "Start conversation"}</button>
    </form>
  );
}
