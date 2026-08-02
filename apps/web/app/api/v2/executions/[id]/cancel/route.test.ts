import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  cancelSession: vi.fn()
}));

vi.mock("../../../../../../lib/relay-v2/server", async importOriginal => {
  const actual = await importOriginal<typeof import("../../../../../../lib/relay-v2/server")>();
  return {
    ...actual,
    getRelayV2ExecutionServices: async () => ({
      engine: { getSession: mocks.getSession, cancelSession: mocks.cancelSession }
    })
  };
});

import { POST } from "./route.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const otherProjectId = "22222222-2222-4222-8222-222222222222";

function request(options: { projectId?: string; host?: string; csrf?: boolean } = {}): NextRequest {
  const query = options.projectId === undefined ? "" : `?projectId=${options.projectId}`;
  const host = options.host ?? "localhost";
  const csrf = options.csrf ?? true;
  return new NextRequest(`http://localhost/api/v2/executions/session/cancel${query}`, {
    method: "POST",
    headers: {
      host,
      origin: "http://localhost",
      ...(csrf ? { cookie: "project_relay_csrf=test-token", "x-csrf-token": "test-token" } : {})
    }
  });
}

describe("project-scoped execution cancellation route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue({ id: "session", projectId, status: "RUNNING" });
    mocks.cancelSession.mockResolvedValue({ id: "session", projectId, status: "CANCELLATION_REQUESTED" });
  });

  it("allows the owning project to cancel", async () => {
    const response = await POST(request({ projectId }), { params: Promise.resolve({ id: "session" }) });
    expect(response.status).toBe(200);
    expect(mocks.cancelSession).toHaveBeenCalledWith("session", "local-user");
  });

  it("returns not found for the wrong project without changing execution status", async () => {
    const session = { id: "session", projectId: otherProjectId, status: "RUNNING" };
    mocks.getSession.mockResolvedValue(session);
    const response = await POST(request({ projectId }), { params: Promise.resolve({ id: "session" }) });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "NOT_FOUND" });
    expect(mocks.cancelSession).not.toHaveBeenCalled();
    expect(session.status).toBe("RUNNING");
  });

  it("rejects a missing projectId", async () => {
    const response = await POST(request(), { params: Promise.resolve({ id: "session" }) });
    expect(response.status).toBe(400);
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.cancelSession).not.toHaveBeenCalled();
  });

  it("rejects forged non-loopback requests before resolving the session", async () => {
    const response = await POST(request({ projectId, host: "relay.example.com" }), { params: Promise.resolve({ id: "session" }) });
    expect(response.status).toBe(403);
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.cancelSession).not.toHaveBeenCalled();
  });

  it("rejects missing CSRF proof before resolving the session", async () => {
    const response = await POST(request({ projectId, csrf: false }), { params: Promise.resolve({ id: "session" }) });
    expect(response.status).toBe(401);
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.cancelSession).not.toHaveBeenCalled();
  });
});
