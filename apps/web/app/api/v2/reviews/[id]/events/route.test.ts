import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getReviewRequest: vi.fn(),
  listEvents: vi.fn()
}));

vi.mock("../../../../../../lib/relay-v2/server", async importOriginal => {
  const actual = await importOriginal<typeof import("../../../../../../lib/relay-v2/server")>();
  return {
    ...actual,
    getRelayV2ReviewServices: async () => ({
      engine: { getReviewRequest: mocks.getReviewRequest, listEvents: mocks.listEvents },
      runtime: { start: vi.fn() }
    })
  };
});

import { GET } from "./route.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const otherProjectId = "22222222-2222-4222-8222-222222222222";

function request(options: { projectId?: string; host?: string; cursor?: string } = {}): NextRequest {
  const params = new URLSearchParams();
  if (options.projectId !== undefined) params.set("projectId", options.projectId);
  if (options.cursor !== undefined) params.set("cursor", options.cursor);
  const query = params.toString() ? `?${params.toString()}` : "";
  const host = options.host ?? "localhost";
  return new NextRequest(`http://localhost/api/v2/reviews/review-1/events${query}`, {
    method: "GET",
    headers: { host, origin: "http://localhost" }
  });
}

describe("project-scoped review events route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getReviewRequest.mockResolvedValue({ id: "review-1", projectId, status: "RUNNING" });
    mocks.listEvents.mockResolvedValue([{ sequence: 1, eventType: "REVIEW_REQUESTED", level: "INFO", message: "ok" }]);
  });

  it("allows the owning project to read events", async () => {
    const response = await GET(request({ projectId }), { params: Promise.resolve({ id: "review-1" }) });
    expect(response.status).toBe(200);
    const body = await response.json() as { events: unknown[] };
    expect(body.events).toHaveLength(1);
    expect(mocks.listEvents).toHaveBeenCalledWith("review-1", 0, 200);
  });

  it("passes the cursor through to listEvents", async () => {
    const response = await GET(request({ projectId, cursor: "5" }), { params: Promise.resolve({ id: "review-1" }) });
    expect(response.status).toBe(200);
    expect(mocks.listEvents).toHaveBeenCalledWith("review-1", 5, 200);
  });

  it("returns not found for the wrong project without calling listEvents", async () => {
    mocks.getReviewRequest.mockResolvedValue({ id: "review-1", projectId: otherProjectId, status: "RUNNING" });
    const response = await GET(request({ projectId }), { params: Promise.resolve({ id: "review-1" }) });
    expect(response.status).toBe(404);
    expect(mocks.listEvents).not.toHaveBeenCalled();
  });

  it("returns the same not-found response for a nonexistent review as for a wrong-project one", async () => {
    mocks.getReviewRequest.mockResolvedValue(null);
    const response = await GET(request({ projectId }), { params: Promise.resolve({ id: "does-not-exist" }) });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects a missing projectId before calling the engine", async () => {
    const response = await GET(request(), { params: Promise.resolve({ id: "review-1" }) });
    expect(response.status).toBe(400);
    expect(mocks.getReviewRequest).not.toHaveBeenCalled();
  });

  it("rejects forged non-loopback requests before calling the engine", async () => {
    const response = await GET(request({ projectId, host: "relay.example.com" }), { params: Promise.resolve({ id: "review-1" }) });
    expect(response.status).toBe(403);
    expect(mocks.getReviewRequest).not.toHaveBeenCalled();
  });
});
