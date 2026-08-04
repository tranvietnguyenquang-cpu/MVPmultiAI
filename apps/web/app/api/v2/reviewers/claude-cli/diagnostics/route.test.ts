import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ refresh: vi.fn(), latest: vi.fn(), require: vi.fn(), describe: vi.fn(), health: vi.fn() }));
vi.mock("../../../../../../lib/relay-v2/server", async importOriginal => {
  const actual = await importOriginal<typeof import("../../../../../../lib/relay-v2/server")>();
  return {
    ...actual,
    getRelayV2ReviewServices: async () => ({
      engine: { reviewers: { require: mocks.require }, latestReviewerCapability: mocks.latest, refreshReviewerCapabilities: mocks.refresh },
      runtime: { status: () => ({ running: false }) }
    })
  };
});

import { GET, POST } from "./route.js";

function request(method: "GET" | "POST", options: { host?: string; csrf?: boolean; body?: unknown } = {}) {
  return new NextRequest("http://localhost/api/v2/reviewers/claude-cli/diagnostics", {
    method,
    headers: {
      host: options.host ?? "localhost", origin: "http://localhost",
      ...(method === "POST" ? { "content-type": "application/json" } : {}),
      ...(method === "POST" && options.csrf !== false ? { cookie: "project_relay_csrf=test-token", "x-csrf-token": "test-token" } : {})
    },
    ...(method === "POST" ? { body: JSON.stringify(options.body ?? {}) } : {})
  });
}

const SANITIZED_DIAGNOSTIC = {
  reviewerId: "claude-cli", displayPath: "%LOCALAPPDATA%/.../claude.exe", version: "2.1.220",
  authenticationStatus: "AUTHENTICATED", authenticationEvidence: "CLAUDE_AUTH_STATUS_JSON",
  supported: true, unsupportedReasons: [], executableIdentityHash: "a".repeat(64), helpHash: "b".repeat(64),
  detectedAt: "2026-08-03T00:00:00.000Z", expiresAt: "2026-08-03T00:05:00.000Z"
};

describe("Claude CLI diagnostics route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.require.mockReturnValue({
      describe: () => ({ id: "claude-cli", displayName: "Claude CLI", providerType: "LOCAL_CLI", readOnly: true, structuredOutput: true, cancellationSupport: true, capabilities: [] }),
      health: async () => ({ healthy: true, checkedAt: "2026-08-03T00:00:00.000Z", message: "Claude CLI 2.1.220 is ready." })
    });
    mocks.latest.mockResolvedValue(SANITIZED_DIAGNOSTIC);
    mocks.refresh.mockResolvedValue({
      descriptor: { id: "claude-cli", displayName: "Claude CLI", providerType: "LOCAL_CLI", readOnly: true, structuredOutput: true, cancellationSupport: true, capabilities: [] },
      health: { healthy: true, checkedAt: "2026-08-03T00:00:00.000Z", message: "Claude CLI 2.1.220 is ready." },
      snapshot: SANITIZED_DIAGNOSTIC, snapshotId: "11111111-1111-1111-1111-111111111111"
    });
  });

  describe("GET", () => {
    it("accepts a loopback request and returns the sanitized descriptor/health/latest diagnostic", async () => {
      const response = await GET(request("GET"));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.descriptor.id).toBe("claude-cli");
      expect(body.health.healthy).toBe(true);
      expect(body.latest.displayPath).toBe(SANITIZED_DIAGNOSTIC.displayPath);
      expect(mocks.refresh).not.toHaveBeenCalled();
    });

    it("rejects a non-loopback request", async () => {
      const response = await GET(request("GET", { host: "relay.example.com" }));
      expect(response.status).toBe(403);
      expect(mocks.require).not.toHaveBeenCalled();
    });

    it("never exposes a raw executable path, USERPROFILE/APPDATA/LOCALAPPDATA value, email, org ID, or raw auth/environment output", async () => {
      const response = await GET(request("GET"));
      const body = JSON.stringify(await response.json());
      expect(body).not.toContain("executablePath");
      expect(body).not.toMatch(/[A-Za-z]:\\Users\\/);
      expect(body).not.toMatch(/loggedIn|orgId|orgName|subscriptionType|email/i);
      if (process.env.USERPROFILE) expect(body).not.toContain(process.env.USERPROFILE);
      if (process.env.APPDATA) expect(body).not.toContain(process.env.APPDATA);
      if (process.env.LOCALAPPDATA) expect(body).not.toContain(process.env.LOCALAPPDATA);
    });

    it("safely represents an unsupported reason without any raw diagnostic dump", async () => {
      mocks.latest.mockResolvedValue({ ...SANITIZED_DIAGNOSTIC, supported: false, authenticationStatus: "UNAVAILABLE", unsupportedReasons: ["Claude CLI executable was not found via RELAY_V2_CLAUDE_PATH, PATH, or a verifiable npm shim."] });
      const response = await GET(request("GET"));
      const body = await response.json();
      expect(body.latest.supported).toBe(false);
      expect(body.latest.unsupportedReasons[0]).toMatch(/not found/);
    });
  });

  describe("POST", () => {
    it("requires loopback", async () => {
      const response = await POST(request("POST", { host: "relay.example.com" }));
      expect(response.status).toBe(403);
      expect(mocks.refresh).not.toHaveBeenCalled();
    });

    it("requires CSRF", async () => {
      const response = await POST(request("POST", { csrf: false }));
      expect(response.status).toBe(401);
      expect(mocks.refresh).not.toHaveBeenCalled();
    });

    it("refreshes capabilities using only operator configuration when loopback+CSRF pass", async () => {
      const response = await POST(request("POST"));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.snapshot.displayPath).toBe(SANITIZED_DIAGNOSTIC.displayPath);
      expect(mocks.refresh).toHaveBeenCalledWith("claude-cli");
      expect(mocks.refresh).toHaveBeenCalledTimes(1);
    });

    it("rejects a request body that attempts to supply an arbitrary executable path or any other field", async () => {
      const response = await POST(request("POST", { body: { executablePath: "C:\\evil\\claude.exe" } }));
      expect(response.status).toBe(400);
      expect(mocks.refresh).not.toHaveBeenCalled();
    });

    it("rejects any unknown field in the request body, even if empty-looking otherwise", async () => {
      const response = await POST(request("POST", { body: { model: "AUTO" } }));
      expect(response.status).toBe(400);
      expect(mocks.refresh).not.toHaveBeenCalled();
    });

    it("uses the same redaction policy as GET -- never exposes a raw path in the refreshed response", async () => {
      const response = await POST(request("POST"));
      const body = JSON.stringify(await response.json());
      expect(body).not.toContain("executablePath");
      if (process.env.USERPROFILE) expect(body).not.toContain(process.env.USERPROFILE);
      if (process.env.LOCALAPPDATA) expect(body).not.toContain(process.env.LOCALAPPDATA);
    });

    it("never itself invokes a review -- only refreshCapabilities-shaped engine methods are ever called", async () => {
      await POST(request("POST"));
      const calledMethodNames = Object.keys(mocks).filter(key => (mocks as Record<string, ReturnType<typeof vi.fn>>)[key]!.mock.calls.length > 0);
      expect(calledMethodNames).toEqual(["refresh"]);
    });
  });
});
