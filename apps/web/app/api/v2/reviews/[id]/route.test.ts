import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getReviewRequest: vi.fn()
}));

vi.mock("../../../../../lib/relay-v2/server", async importOriginal => {
  const actual = await importOriginal<typeof import("../../../../../lib/relay-v2/server")>();
  return {
    ...actual,
    getRelayV2ReviewServices: async () => ({
      engine: { getReviewRequest: mocks.getReviewRequest },
      runtime: { start: vi.fn() }
    })
  };
});

import { GET } from "./route.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const otherProjectId = "22222222-2222-4222-8222-222222222222";

function request(options: { projectId?: string; host?: string } = {}): NextRequest {
  const query = options.projectId === undefined ? "" : `?projectId=${options.projectId}`;
  const host = options.host ?? "localhost";
  return new NextRequest(`http://localhost/api/v2/reviews/review-1${query}`, {
    method: "GET",
    headers: { host, origin: "http://localhost" }
  });
}

describe("project-scoped review detail route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getReviewRequest.mockResolvedValue({ id: "review-1", projectId, status: "APPROVED" });
  });

  it("allows the owning project to read the review", async () => {
    const response = await GET(request({ projectId }), { params: Promise.resolve({ id: "review-1" }) });
    expect(response.status).toBe(200);
    const body = await response.json() as { reviewRequest: { id: string } };
    expect(body.reviewRequest.id).toBe("review-1");
  });

  it("returns not found for the wrong project", async () => {
    mocks.getReviewRequest.mockResolvedValue({ id: "review-1", projectId: otherProjectId, status: "APPROVED" });
    const response = await GET(request({ projectId }), { params: Promise.resolve({ id: "review-1" }) });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "NOT_FOUND" });
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
