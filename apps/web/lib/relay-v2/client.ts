"use client";

/** Relay v2 deliberately avoids the legacy PostgreSQL-backed session bootstrap. */
export async function relayV2Fetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const tokenResponse = await fetch("/api/csrf", { cache: "no-store" });
  if (!tokenResponse.ok) throw new Error("Could not establish a CSRF session.");
  const { token } = await tokenResponse.json() as { token: string };
  const headers = new Headers(init.headers);
  headers.set("x-csrf-token", token);
  return fetch(input, { ...init, headers });
}
