import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { proxy } from "./proxy.js";

function requestWithHeaders(headers: Record<string, string>) {
  return new NextRequest("http://placeholder.local/api/conversations/abc/messages", { headers, method: "POST" });
}

describe("loopback + CSRF proxy", () => {
  it("allows a loopback GET request through", () => {
    const response = proxy(new NextRequest("http://placeholder.local/api/conversations/abc", { headers: { host: "127.0.0.1:3300" } }));
    expect(response.status).not.toBe(403);
  });

  it("allows a localhost request through", () => {
    const response = proxy(new NextRequest("http://placeholder.local/api/conversations/abc", { headers: { host: "localhost:3300" } }));
    expect(response.status).not.toBe(403);
  });

  it("rejects a non-loopback API request before any CSRF check runs", async () => {
    const response = proxy(requestWithHeaders({ host: "example.com" }));
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toMatch(/loopback/i);
  });

  it("rejects a request carrying a forwarded-for header even with a loopback Host", async () => {
    const response = proxy(requestWithHeaders({ host: "127.0.0.1:3300", "x-forwarded-for": "203.0.113.5" }));
    expect(response.status).toBe(403);
  });

  it("still enforces same-origin CSRF for a loopback mutating request", async () => {
    const response = proxy(requestWithHeaders({ host: "127.0.0.1:3300", origin: "https://evil.test" }));
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toMatch(/CSRF/i);
  });
});
