import { describe, expect, it } from "vitest";
import { assertLoopbackHost, isLoopbackHost, isLoopbackRequestHeaders } from "./index.js";

describe("isLoopbackHost", () => {
  it("accepts loopback access", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("127.5.10.2")).toBe(true);
    expect(isLoopbackHost("::ffff:127.0.0.1")).toBe(true);
  });

  it("rejects non-loopback hosts", () => {
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("192.168.1.10")).toBe(false);
    expect(isLoopbackHost("example.com")).toBe(false);
    expect(isLoopbackHost("")).toBe(false);
  });
});

describe("assertLoopbackHost", () => {
  it("passes for loopback hosts (startup succeeds)", () => {
    expect(() => assertLoopbackHost("127.0.0.1", "DATABASE_URL")).not.toThrow();
  });

  it("fails closed for a non-loopback bind address", () => {
    expect(() => assertLoopbackHost("0.0.0.0", "PROJECT_RELAY_BIND_HOST")).toThrow(/loopback-only/);
    expect(() => assertLoopbackHost("10.0.0.5", "REDIS_URL")).toThrow(/loopback-only/);
  });
});

describe("isLoopbackRequestHeaders", () => {
  it("accepts a request whose Host is loopback and carries no proxy headers", () => {
    expect(isLoopbackRequestHeaders({ host: "127.0.0.1:3300", forwardedFor: null, forwardedHost: null })).toBe(true);
    expect(isLoopbackRequestHeaders({ host: "localhost:3300", forwardedFor: null, forwardedHost: null })).toBe(true);
  });

  it("rejects a request with a non-loopback Host", () => {
    expect(isLoopbackRequestHeaders({ host: "example.com", forwardedFor: null, forwardedHost: null })).toBe(false);
    expect(isLoopbackRequestHeaders({ host: "203.0.113.5:3300", forwardedFor: null, forwardedHost: null })).toBe(false);
  });

  it("rejects forwarded headers that reveal a real, non-loopback remote client or host", () => {
    expect(isLoopbackRequestHeaders({ host: "127.0.0.1:3300", forwardedFor: "203.0.113.5", forwardedHost: null })).toBe(false);
    expect(isLoopbackRequestHeaders({ host: "127.0.0.1:3300", forwardedFor: null, forwardedHost: "example.com" })).toBe(false);
    // The leftmost address in a comma-separated X-Forwarded-For chain is the original client.
    expect(isLoopbackRequestHeaders({ host: "127.0.0.1:3300", forwardedFor: "203.0.113.5, 127.0.0.1", forwardedHost: null })).toBe(false);
  });

  it("accepts self-consistent loopback forwarded headers (Next.js's own server injects these on every request, even a direct local connection)", () => {
    expect(isLoopbackRequestHeaders({ host: "127.0.0.1:3300", forwardedFor: "127.0.0.1", forwardedHost: "127.0.0.1:3300" })).toBe(true);
    expect(isLoopbackRequestHeaders({ host: "localhost:3300", forwardedFor: "::1", forwardedHost: "localhost:3300" })).toBe(true);
  });
});
