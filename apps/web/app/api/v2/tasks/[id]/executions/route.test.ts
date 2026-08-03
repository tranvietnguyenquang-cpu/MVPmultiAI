import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExecutionAuthorityError } from "@project-relay/relay-v2-execution";

const mocks = vi.hoisted(() => ({ requestExecution: vi.fn(), start: vi.fn() }));
vi.mock("../../../../../../lib/relay-v2/server", async importOriginal => {
  const actual = await importOriginal<typeof import("../../../../../../lib/relay-v2/server")>();
  return { ...actual, getRelayV2ExecutionServices: async () => ({ engine: { requestExecution: mocks.requestExecution }, runtime: { start: mocks.start } }) };
});

import { POST } from "./route.js";

function request(body: unknown, options: { host?: string; csrf?: boolean } = {}) {
  return new NextRequest("http://localhost/api/v2/tasks/task/executions", {
    method: "POST", body: JSON.stringify(body),
    headers: {
      host: options.host ?? "localhost", origin: "http://localhost", "content-type": "application/json",
      ...(options.csrf === false ? {} : { cookie: "project_relay_csrf=test-token", "x-csrf-token": "test-token" })
    }
  });
}

describe("POST /api/v2/tasks/[id]/executions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requestExecution.mockResolvedValue({ session: { id: "session", status: "QUEUED" }, duplicate: false });
  });

  it("creates durable work through ExecutionEngine and passes the exact dirty-baseline acknowledgement", async () => {
    const hash = "a".repeat(64);
    const response = await POST(request({ dirtyBaselineAcknowledgedHash: hash }), { params: Promise.resolve({ id: "task" }) });
    expect(response.status).toBe(201);
    expect(mocks.requestExecution).toHaveBeenCalledWith("task", "local-user", { dirtyBaselineAcknowledgedHash: hash });
    expect(mocks.start).toHaveBeenCalledOnce();
  });

  it("does not start the runtime when approval authority is rejected", async () => {
    mocks.requestExecution.mockRejectedValue(new ExecutionAuthorityError("Approval is stale."));
    const response = await POST(request({}), { params: Promise.resolve({ id: "task" }) });
    expect(response.status).toBe(403);
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("rejects non-loopback and missing-CSRF mutations before reaching the engine", async () => {
    expect((await POST(request({}, { host: "relay.example.com" }), { params: Promise.resolve({ id: "task" }) })).status).toBe(403);
    expect((await POST(request({}, { csrf: false }), { params: Promise.resolve({ id: "task" }) })).status).toBe(401);
    expect(mocks.requestExecution).not.toHaveBeenCalled();
  });
});
