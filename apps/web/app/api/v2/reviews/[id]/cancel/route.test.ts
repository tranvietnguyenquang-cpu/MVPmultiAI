import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getReviewRequest: vi.fn(),
  cancelReview: vi.fn()
}));

vi.mock("../../../../../../lib/relay-v2/server", async importOriginal => {
  const actual = await importOriginal<typeof import("../../../../../../lib/relay-v2/server")>();
  return {
    ...actual,
    getRelayV2ReviewServices: async () => ({
      engine: { getReviewRequest: mocks.getReviewRequest, cancelReview: mocks.cancelReview },
      runtime: { start: vi.fn() }
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
  return new NextRequest(`http://localhost/api/v2/reviews/review-1/cancel${query}`, {
    method: "POST",
    headers: {
      host, origin: "http://localhost",
      ...(csrf ? { cookie: "project_relay_csrf=test-token", "x-csrf-token": "test-token" } : {})
    }
  });
}

describe("project-scoped review cancellation route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getReviewRequest.mockResolvedValue({ id: "review-1", projectId, status: "RUNNING" });
    mocks.cancelReview.mockResolvedValue({ alreadyTerminal: false, reviewRequest: { id: "review-1", status: "CANCELLED" } });
  });

  it("allows the owning project to cancel", async () => {
    const response = await POST(request({ projectId }), { params: Promise.resolve({ id: "review-1" }) });
    expect(response.status).toBe(200);
    expect(mocks.cancelReview).toHaveBeenCalledWith("review-1", "local-user");
  });

  it("returns not found for the wrong project without calling cancelReview", async () => {
    mocks.getReviewRequest.mockResolvedValue({ id: "review-1", projectId: otherProjectId, status: "RUNNING" });
    const response = await POST(request({ projectId }), { params: Promise.resolve({ id: "review-1" }) });
    expect(response.status).toBe(404);
    expect(mocks.cancelReview).not.toHaveBeenCalled();
  });

  it("returns not found for a nonexistent review, indistinguishable from wrong-project", async () => {
    mocks.getReviewRequest.mockResolvedValue(null);
    const response = await POST(request({ projectId }), { params: Promise.resolve({ id: "does-not-exist" }) });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects forged non-loopback requests before resolving the review", async () => {
    const response = await POST(request({ projectId, host: "relay.example.com" }), { params: Promise.resolve({ id: "review-1" }) });
    expect(response.status).toBe(403);
    expect(mocks.getReviewRequest).not.toHaveBeenCalled();
  });

  it("rejects missing CSRF proof before resolving the review", async () => {
    const response = await POST(request({ projectId, csrf: false }), { params: Promise.resolve({ id: "review-1" }) });
    expect(response.status).toBe(401);
    expect(mocks.getReviewRequest).not.toHaveBeenCalled();
  });
});
