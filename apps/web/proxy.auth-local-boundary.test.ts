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

  it("allows a request whose forwarded headers are themselves loopback-consistent (Next.js injects these on every real request)", () => {
    const response = proxy(new NextRequest("http://placeholder.local/api/conversations/abc", {
      headers: { host: "127.0.0.1:3300", "x-forwarded-for": "127.0.0.1", "x-forwarded-host": "127.0.0.1:3300" }
    }));
    expect(response.status).not.toBe(403);
  });

  it("still enforces same-origin CSRF for a loopback mutating request", async () => {
    const response = proxy(requestWithHeaders({ host: "127.0.0.1:3300", origin: "https://evil.test" }));
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toMatch(/CSRF/i);
  });

  describe("local-session bootstrap exemption", () => {
    function bootstrapRequest(headers: Record<string, string>) {
      return new NextRequest("http://placeholder.local/api/auth/local-session", { headers, method: "POST" });
    }

    it("allows the bootstrap POST through without a pre-existing CSRF token (same-origin, no cookie/header yet)", () => {
      const response = proxy(bootstrapRequest({ host: "localhost:3300", origin: "http://placeholder.local" }));
      expect(response.status).not.toBe(403);
    });

    it("still rejects the bootstrap POST from a cross-origin page", async () => {
      const response = proxy(bootstrapRequest({ host: "localhost:3300", origin: "https://evil.test" }));
      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toMatch(/cross-origin/i);
    });

    it("still rejects the bootstrap POST from a non-loopback host before the CSRF exemption is even considered", async () => {
      const response = proxy(bootstrapRequest({ host: "example.com", origin: "http://example.com" }));
      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toMatch(/loopback/i);
    });
  });
});
