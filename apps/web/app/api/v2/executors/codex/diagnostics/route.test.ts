import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ refresh: vi.fn(), latest: vi.fn(), require: vi.fn() }));
vi.mock("../../../../../../lib/relay-v2/server", async importOriginal => {
  const actual = await importOriginal<typeof import("../../../../../../lib/relay-v2/server")>();
  return { ...actual, getRelayV2ExecutionServices: async () => ({
    engine: { refreshExecutorCapabilities: mocks.refresh, latestExecutorCapability: mocks.latest, executors: { require: mocks.require } },
    runtime: { status: () => ({ running: false }) }
  }) };
});

import { GET, POST } from "./route.js";

function request(method: "GET" | "POST", options: { host?: string; csrf?: boolean } = {}) {
  return new NextRequest("http://localhost/api/v2/executors/codex/diagnostics", {
    method, headers: {
      host: options.host ?? "localhost", origin: "http://localhost",
      ...(method === "POST" && options.csrf !== false ? { cookie: "project_relay_csrf=test-token", "x-csrf-token": "test-token" } : {})
    }
  });
}

describe("Codex diagnostics route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.require.mockReturnValue({ describe: () => ({ id: "codex-cli" }) });
    const safeSnapshot = {
      executorId: "codex-cli", version: "fixture", displayPath: "%LOCALAPPDATA%\\OpenAI\\Codex\\codex.exe",
      supported: true, authenticationStatus: "UNKNOWN", authenticationEvidence: "CODEX_LOGIN_STATUS",
      realExecutionReadiness: "NOT_PROVEN", detectedAt: "2026-08-03T00:00:00.000Z"
    };
    mocks.latest.mockResolvedValue(safeSnapshot);
    mocks.refresh.mockResolvedValue({ snapshot: safeSnapshot });
  });

  it("reads only the persisted capability snapshot on GET", async () => {
    const response = await GET(request("GET"));
    expect(response.status).toBe(200);
    const body = JSON.stringify(await response.json());
    expect(body).toContain("displayPath");
    expect(body).not.toContain("executablePath");
    expect(body).not.toContain(process.env.USERNAME ?? "__no_username__");
    if (process.env.USERPROFILE) expect(body).not.toContain(process.env.USERPROFILE);
    if (process.env.LOCALAPPDATA) expect(body).not.toContain(process.env.LOCALAPPDATA);
    expect(mocks.latest).toHaveBeenCalledWith("codex-cli");
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("runs capability discovery only through the engine service on protected POST", async () => {
    const response = await POST(request("POST"));
    expect(response.status).toBe(200);
    const body = JSON.stringify(await response.json());
    expect(body).toContain("displayPath");
    expect(body).not.toContain("executablePath");
    if (process.env.USERPROFILE) expect(body).not.toContain(process.env.USERPROFILE);
    if (process.env.LOCALAPPDATA) expect(body).not.toContain(process.env.LOCALAPPDATA);
    expect(mocks.refresh).toHaveBeenCalledWith("codex-cli");
  });

  it("rejects non-loopback and missing-CSRF diagnostic mutations", async () => {
    expect((await POST(request("POST", { host: "relay.example.com" }))).status).toBe(403);
    expect((await POST(request("POST", { csrf: false }))).status).toBe(401);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});
