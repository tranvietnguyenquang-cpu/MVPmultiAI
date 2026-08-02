import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { POST } from "./route.js";

const validBody = {
  name: "Rejected before persistence",
  localPath: "C:\\does-not-matter"
};

function mutationRequest(headers: Record<string, string>): NextRequest {
  return new NextRequest("http://localhost/api/v2/projects", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(validBody)
  });
}

describe("POST /api/v2/projects HTTP safety boundary", () => {
  it("rejects a non-loopback Host before parsing or persistence", async () => {
    const response = await POST(mutationRequest({ host: "example.com", origin: "http://localhost" }));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "FORBIDDEN", error: expect.stringMatching(/local requests/i) });
  });

  it("rejects a loopback mutation without a matching CSRF cookie and header", async () => {
    const response = await POST(mutationRequest({ host: "localhost", origin: "http://localhost" }));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: "UNAUTHENTICATED", error: expect.stringMatching(/CSRF/i) });
  });
});
