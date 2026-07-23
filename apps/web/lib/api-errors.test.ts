import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ApiError, apiErrorResponse } from "./api-errors.js";

describe("apiErrorResponse", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns an ApiError's own stable code, message, and status verbatim", async () => {
    const response = apiErrorResponse(new ApiError("NOT_FOUND", "Conversation not found."), "test");
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body).toEqual({ error: "Conversation not found.", code: "NOT_FOUND" });
  });

  it("maps every ApiError code to its documented status", async () => {
    const cases: Array<[ConstructorParameters<typeof ApiError>[0], number]> = [
      ["VALIDATION_ERROR", 400],
      ["UNAUTHENTICATED", 401],
      ["FORBIDDEN", 403],
      ["NOT_FOUND", 404],
      ["CONFLICT", 409],
      ["INTERNAL_ERROR", 500]
    ];
    for (const [code, status] of cases) {
      const response = apiErrorResponse(new ApiError(code, "x"), "test");
      expect(response.status).toBe(status);
    }
  });

  it("never leaks a raw Prisma/connection-string error to the client, and logs the real detail server-side", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const raw = new Error("Connection to postgresql://projectrelay:supersecret@localhost:5432/projectrelay failed: ECONNREFUSED");

    const response = apiErrorResponse(raw, "test-context");

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.code).toBe("INTERNAL_ERROR");
    expect(body.error).toBe("An unexpected error occurred. Please try again.");
    expect(body.error).not.toContain("supersecret");
    expect(body.error).not.toContain("postgresql://");

    expect(spy).toHaveBeenCalledWith("[api:test-context]", raw);
  });

  it("never leaks a raw spawn/path error (e.g. ENOENT with an absolute workspace path)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const raw = new Error("spawn C:\\Users\\alice\\repos\\secret-project\\codex.exe ENOENT");

    const response = apiErrorResponse(raw, "test-context");
    const body = await response.json();
    expect(body.error).not.toContain("secret-project");
    expect(body.error).not.toContain("alice");
    expect(body.code).toBe("INTERNAL_ERROR");
  });

  it("never leaks a malformed queued-job payload error verbatim", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const raw = new Error("Cross-wired execution: the routing decision's selected provider does not match the agent session's provider.");

    const response = apiErrorResponse(raw, "test-context");
    const body = await response.json();
    expect(body.error).toBe("An unexpected error occurred. Please try again.");
    expect(body.code).toBe("INTERNAL_ERROR");
  });

  it("treats a ZodError as a safe, structured validation error rather than a generic internal one", async () => {
    const schema = z.object({ title: z.string().min(1) });
    const result = schema.safeParse({ title: "" });
    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected failure");

    const response = apiErrorResponse(result.error, "test");
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(body.error).toBe(result.error.issues[0]?.message);
  });

  it("redacts a secret embedded in an ApiError message too, as a backstop", async () => {
    const response = apiErrorResponse(new ApiError("CONFLICT", "Provider rejected token=sk-abcdefghijklmnopqrstuvwxyz"), "test");
    const body = await response.json();
    expect(body.error).toContain("[REDACTED]");
    expect(body.error).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
  });
});
