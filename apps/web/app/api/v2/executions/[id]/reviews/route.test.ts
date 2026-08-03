import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requestReview: vi.fn(),
  listReviewsForExecution: vi.fn(),
  reviewGateProjection: vi.fn(),
  getExecutionSessionProject: vi.fn()
}));

vi.mock("../../../../../../lib/relay-v2/server", async importOriginal => {
  const actual = await importOriginal<typeof import("../../../../../../lib/relay-v2/server")>();
  return {
    ...actual,
    getRelayV2ReviewServices: async () => ({
      engine: {
        requestReview: mocks.requestReview, listReviewsForExecution: mocks.listReviewsForExecution,
        reviewGateProjection: mocks.reviewGateProjection, getExecutionSessionProject: mocks.getExecutionSessionProject
      },
      runtime: { start: vi.fn() }
    })
  };
});

import { GET, POST } from "./route.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const otherProjectId = "22222222-2222-4222-8222-222222222222";

function request(method: "GET" | "POST", options: { projectId?: string; host?: string; csrf?: boolean; body?: unknown } = {}): NextRequest {
  const query = options.projectId === undefined ? "" : `?projectId=${options.projectId}`;
  const host = options.host ?? "localhost";
  const csrf = options.csrf ?? true;
  return new NextRequest(`http://localhost/api/v2/executions/session/reviews${query}`, {
    method,
    headers: {
      host,
      origin: "http://localhost",
      "content-type": "application/json",
      ...(method === "POST" && csrf ? { cookie: "project_relay_csrf=test-token", "x-csrf-token": "test-token" } : {})
    },
    ...(method === "POST" ? { body: JSON.stringify(options.body ?? {}) } : {})
  });
}

describe("project-scoped review request route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requestReview.mockResolvedValue({ reviewRequest: { id: "review-1", projectId, status: "PENDING" }, duplicate: false });
    mocks.listReviewsForExecution.mockResolvedValue([{ id: "review-1", projectId, status: "APPROVED" }]);
    mocks.reviewGateProjection.mockResolvedValue({ state: "APPROVED", authority: "DIAGNOSTIC", reviewerId: "fake-reviewer", reviewRequestId: "review-1", verdictId: "verdict-1", requestHash: "a".repeat(64), commitAuthorityEligible: false });
    mocks.getExecutionSessionProject.mockResolvedValue(projectId);
  });

  it("allows the owning project to request a review", async () => {
    const response = await POST(request("POST", { projectId }), { params: Promise.resolve({ id: "session" }) });
    expect(response.status).toBe(201);
    expect(mocks.requestReview).toHaveBeenCalledWith("session", projectId, "fake-reviewer", "local-user", expect.objectContaining({ diagnostic: false }));
  });

  it("rejects a missing projectId before calling the engine", async () => {
    const response = await POST(request("POST"), { params: Promise.resolve({ id: "session" }) });
    expect(response.status).toBe(400);
    expect(mocks.requestReview).not.toHaveBeenCalled();
  });

  it("rejects forged non-loopback requests before calling the engine", async () => {
    const response = await POST(request("POST", { projectId, host: "relay.example.com" }), { params: Promise.resolve({ id: "session" }) });
    expect(response.status).toBe(403);
    expect(mocks.requestReview).not.toHaveBeenCalled();
  });

  it("rejects missing CSRF proof before calling the engine", async () => {
    const response = await POST(request("POST", { projectId, csrf: false }), { params: Promise.resolve({ id: "session" }) });
    expect(response.status).toBe(401);
    expect(mocks.requestReview).not.toHaveBeenCalled();
  });

  it("lists reviews scoped to the owning project", async () => {
    const response = await GET(request("GET", { projectId }), { params: Promise.resolve({ id: "session" }) });
    expect(response.status).toBe(200);
    const body = await response.json() as { reviews: unknown[]; reviewGate: { state: string; authority: string; commitAuthorityEligible: boolean } };
    expect(body.reviews).toHaveLength(1);
    expect(body.reviewGate.state).toBe("APPROVED");
    expect(body.reviewGate.authority).toBe("DIAGNOSTIC");
    expect(body.reviewGate.commitAuthorityEligible).toBe(false);
  });

  it("returns an empty list (not not-found) for the owning project with zero reviews", async () => {
    mocks.listReviewsForExecution.mockResolvedValue([]);
    mocks.reviewGateProjection.mockResolvedValue({ state: "NOT_REQUESTED", authority: "NONE", reviewerId: null, reviewRequestId: null, verdictId: null, requestHash: null, commitAuthorityEligible: false });
    const response = await GET(request("GET", { projectId }), { params: Promise.resolve({ id: "session" }) });
    expect(response.status).toBe(200);
    const body = await response.json() as { reviews: unknown[]; reviewGate: { state: string } };
    expect(body.reviews).toHaveLength(0);
    expect(body.reviewGate.state).toBe("NOT_REQUESTED");
  });

  it("returns not-found for a wrong-project execution even when it has zero reviews", async () => {
    mocks.getExecutionSessionProject.mockResolvedValue(otherProjectId);
    mocks.listReviewsForExecution.mockResolvedValue([]);
    const response = await GET(request("GET", { projectId }), { params: Promise.resolve({ id: "session" }) });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "NOT_FOUND" });
    expect(mocks.listReviewsForExecution).not.toHaveBeenCalled();
  });

  it("returns the same not-found response for a nonexistent execution as for a wrong-project one", async () => {
    mocks.getExecutionSessionProject.mockResolvedValue(null);
    const response = await GET(request("GET", { projectId }), { params: Promise.resolve({ id: "does-not-exist" }) });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "NOT_FOUND" });
  });

  it("hides reviews that belong to a different project", async () => {
    mocks.getExecutionSessionProject.mockResolvedValue(otherProjectId);
    mocks.listReviewsForExecution.mockResolvedValue([{ id: "review-1", projectId: otherProjectId, status: "APPROVED" }]);
    const response = await GET(request("GET", { projectId }), { params: Promise.resolve({ id: "session" }) });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "NOT_FOUND" });
  });
});
