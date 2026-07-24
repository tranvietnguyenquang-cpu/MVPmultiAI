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

  describe("canonical origin redirect (127.0.0.1 -> localhost)", () => {
    // A plain 3xx redirect's Location header gets silently relativized by Next's own
    // request handling whenever the target matches request.nextUrl.origin - which always
    // reports "http://localhost:<port>" here, the very quirk this exists to work around.
    // So the canonicalization response is a tiny same-origin-looking HTML document (status
    // 200) whose only content is a `location.replace(...)` script carrying the real
    // absolute target - the browser navigates via ordinary page script, not a Location
    // header Next could rewrite.
    async function redirectTarget(response: Response): Promise<string> {
      const body = await response.text();
      const match = /location\.replace\("([^"]+)"\)/.exec(body);
      if (!match) throw new Error(`No location.replace(...) script found in response body: ${body}`);
      return match[1]!;
    }

    it("redirects a loopback GET request from 127.0.0.1 to the canonical localhost origin, preserving path and query", async () => {
      const response = proxy(new NextRequest("http://placeholder.local/projects/abc?tab=conversations", { headers: { host: "127.0.0.1:3300" } }));
      expect(response.status).toBe(200);
      expect(await redirectTarget(response)).toBe("http://localhost:3300/projects/abc?tab=conversations");
    });

    it("redirects the root page before any client script could ever reach session bootstrap", async () => {
      const response = proxy(new NextRequest("http://placeholder.local/", { headers: { host: "127.0.0.1:3300" } }));
      expect(response.status).toBe(200);
      expect(await redirectTarget(response)).toBe("http://localhost:3300/");
    });

    it("redirects an API GET request from 127.0.0.1 to localhost as well", async () => {
      const response = proxy(new NextRequest("http://placeholder.local/api/conversations/abc", { headers: { host: "127.0.0.1:3300" } }));
      expect(response.status).toBe(200);
      expect(await redirectTarget(response)).toBe("http://localhost:3300/api/conversations/abc");
    });

    it("does not redirect a request already on the canonical localhost origin", async () => {
      const response = proxy(new NextRequest("http://placeholder.local/", { headers: { host: "localhost:3300" } }));
      expect((await response.text())).not.toContain("location.replace");
    });

    it("does not redirect a non-loopback GET request - it is neither redirected nor silently allowed through the API gate", async () => {
      const response = proxy(new NextRequest("http://placeholder.local/api/conversations/abc", { headers: { host: "example.com" } }));
      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toMatch(/loopback/i);
    });

    it("does not redirect a request whose forwarded-for header contradicts a loopback Host (spoofed loopback)", async () => {
      const response = proxy(new NextRequest("http://placeholder.local/api/conversations/abc", {
        headers: { host: "127.0.0.1:3300", "x-forwarded-for": "203.0.113.5" }
      }));
      expect(response.status).toBe(403);
    });

    it("never redirects a mutating request - CSRF/loopback enforcement on 127.0.0.1 POSTs is unweakened", async () => {
      const response = proxy(requestWithHeaders({ host: "127.0.0.1:3300", origin: "https://evil.test" }));
      expect(response.status).not.toBe(307);
      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toMatch(/CSRF/i);
    });
  });
});
