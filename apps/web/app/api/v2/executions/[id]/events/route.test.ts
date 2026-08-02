import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  listEvents: vi.fn(),
  start: vi.fn(),
  requireRead: vi.fn()
}));

vi.mock("../../../../../../lib/relay-v2/server", () => ({
  requireRelayV2Read: mocks.requireRead,
  getRelayV2ExecutionServices: async () => ({
    engine: { getSession: mocks.getSession, listEvents: mocks.listEvents },
    runtime: { start: mocks.start }
  })
}));

import { GET } from "./route.js";

function request(cursor = 0, lastEventId?: number) {
  return new NextRequest(`http://localhost/api/v2/executions/session/events?projectId=11111111-1111-4111-8111-111111111111&cursor=${cursor}`, {
    headers: { host: "localhost", ...(lastEventId === undefined ? {} : { "last-event-id": String(lastEventId) }) }
  });
}

const event = (sequence: number) => ({
  id: `event-${sequence}`, sessionId: "session", sequence, eventType: "OUTPUT_RECEIVED", level: "INFO",
  message: `output ${sequence}`, payloadJson: "{}", createdAt: new Date(`2026-08-02T00:00:0${sequence}.000Z`)
});

describe("execution SSE route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue({ id: "session", projectId: "11111111-1111-4111-8111-111111111111", status: "SUCCEEDED" });
    mocks.listEvents.mockImplementation(async (_id: string, cursor: number) => [event(1), event(2)].filter(item => item.sequence > cursor));
  });

  afterEach(() => vi.unstubAllEnvs());

  it("delivers persisted initial events in order and closes cleanly at terminal state", async () => {
    const response = await GET(request(), { params: Promise.resolve({ id: "session" }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const body = await response.text();
    expect(body.indexOf("id: 1")).toBeLessThan(body.indexOf("id: 2"));
    expect(body).toContain("event: complete");
  });

  it("resumes after the cursor without duplicate delivery", async () => {
    const body = await (await GET(request(1), { params: Promise.resolve({ id: "session" }) })).text();
    expect(body).not.toContain("id: 1\n");
    expect(body.match(/id: 2\n/g)).toHaveLength(1);
  });

  it("prefers the native EventSource Last-Event-ID cursor on reconnect", async () => {
    const body = await (await GET(request(0, 1), { params: Promise.resolve({ id: "session" }) })).text();
    expect(body).not.toContain("id: 1\n");
    expect(body.match(/id: 2\n/g)).toHaveLength(1);
  });

  it("closes a nonterminal stream at the configurable bounded connection deadline", async () => {
    vi.stubEnv("RELAY_V2_SSE_CONNECTION_LIFETIME_MS", "0");
    mocks.getSession.mockResolvedValue({ id: "session", projectId: "11111111-1111-4111-8111-111111111111", status: "RUNNING" });
    mocks.listEvents.mockResolvedValue([]);
    const body = await (await GET(request(), { params: Promise.resolve({ id: "session" }) })).text();
    expect(body).toContain("retry: 250");
    expect(body).not.toContain("event: complete");
    expect(mocks.listEvents).not.toHaveBeenCalled();
  });

  it("streams an incrementally persisted event before terminal completion", async () => {
    let call = 0;
    mocks.listEvents.mockImplementation(async (_id: string, cursor: number) => {
      call += 1;
      return call === 1 ? [event(1)].filter(item => item.sequence > cursor) : [event(2)].filter(item => item.sequence > cursor);
    });
    mocks.getSession.mockImplementation(async () => ({ id: "session", projectId: "11111111-1111-4111-8111-111111111111", status: call < 2 ? "RUNNING" : "SUCCEEDED" }));
    const body = await (await GET(request(), { params: Promise.resolve({ id: "session" }) })).text();
    expect(body).toContain("id: 1");
    expect(body).toContain("id: 2");
    expect(body).toContain("event: complete");
  });

  it("rejects a session that is not owned by the requested project", async () => {
    mocks.getSession.mockResolvedValue({ id: "session", projectId: "22222222-2222-4222-8222-222222222222", status: "RUNNING" });
    const response = await GET(request(), { params: Promise.resolve({ id: "session" }) });
    expect(response.status).toBe(404);
    expect(mocks.listEvents).not.toHaveBeenCalled();
  });
});
