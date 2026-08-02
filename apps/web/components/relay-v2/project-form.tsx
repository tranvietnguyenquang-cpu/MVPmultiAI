"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { relayV2Fetch } from "../../lib/relay-v2/client";

export function RelayV2ProjectForm() {
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
    try {
      const response = await relayV2Fetch("/api/v2/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: form.get("name"), localPath: form.get("localPath"), description: form.get("description") })
      });
      const result = await response.json() as { id?: string; error?: string };
      if (!response.ok) throw new Error(result.error ?? "Could not create the project.");
      router.push(`/v2/projects`);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create the project.");
    } finally {
      setBusy(false);
    }
  }

  return <form className="form" onSubmit={submit}>
    <label>Project name<input name="name" required maxLength={100}/></label>
    <label>Absolute Git repository path<input name="localPath" required placeholder="C:\work\my-project"/></label>
    <label>Description<textarea name="description" maxLength={2000}/></label>
    <p className="subtle">Relay validates the canonical local path. Project creation does not inspect providers or start execution.</p>
    {error ? <p className="warn">{error}</p> : null}
    <button disabled={!hydrated || busy}>{busy ? "Creating..." : "Create project"}</button>
  </form>;
}
