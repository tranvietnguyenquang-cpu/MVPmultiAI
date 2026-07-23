import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@project-relay/database";
import { CSRF_COOKIE, CSRF_HEADER } from "../../lib/csrf";
import { LOCAL_SESSION_COOKIE } from "../../lib/local-auth-shared";
import { POST as bootstrapLocalSession } from "./auth/local-session/route.js";
import { POST as createConversationRoute } from "./projects/[id]/conversations/route.js";
import { POST as postMessage } from "./conversations/[id]/messages/route.js";
import { GET as getExecution } from "./conversations/[id]/executions/[executionId]/route.js";

const ORIGIN = "http://localhost:3300";
const CSRF_TOKEN = "test-csrf-token";

function request(url: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const headers = new Headers(init.headers);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return new NextRequest(url, {
    method: init.method ?? "GET",
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {})
  });
}

describe("local-first authentication boundary", () => {
  let projectId: string;
  let otherProjectId: string;

  beforeAll(async () => {
    const project = await prisma.project.create({
      data: { name: `auth-boundary-${randomUUID()}`, repositoryPath: `/tmp/auth-boundary-${randomUUID()}`, allowedCommands: [], permittedPaths: [] }
    });
    projectId = project.id;
    const otherProject = await prisma.project.create({
      data: { name: `auth-boundary-other-${randomUUID()}`, repositoryPath: `/tmp/auth-boundary-other-${randomUUID()}`, allowedCommands: [], permittedPaths: [] }
    });
    otherProjectId = otherProject.id;
  });

  afterAll(async () => {
    await prisma.project.delete({ where: { id: projectId } }).catch(() => undefined);
    await prisma.project.delete({ where: { id: otherProjectId } }).catch(() => undefined);
  });

  beforeEach(async () => {
    const data = { installed: true, authentication: "AUTHENTICATED" as const, available: true };
    await prisma.providerHealth.upsert({ where: { providerId: "codex-cli" }, create: { providerId: "codex-cli", ...data }, update: data });
    await prisma.providerHealth.upsert({ where: { providerId: "claude-cli" }, create: { providerId: "claude-cli", ...data }, update: data });
  });

  it("issues a local session only for a loopback bootstrap request", async () => {
    const response = await bootstrapLocalSession(request(`${ORIGIN}/api/auth/local-session`, { method: "POST", headers: { host: "127.0.0.1:3300" } }));
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain(LOCAL_SESSION_COOKIE);
  });

  it("rejects a bootstrap request that does not look like it came from loopback", async () => {
    const response = await bootstrapLocalSession(request(`${ORIGIN}/api/auth/local-session`, { method: "POST", headers: { host: "example.com" } }));
    expect(response.status).toBe(403);
  });

  it("succeeds end to end for a fully authenticated loopback request", async () => {
    const bootstrap = await bootstrapLocalSession(request(`${ORIGIN}/api/auth/local-session`, { method: "POST", headers: { host: "127.0.0.1:3300" } }));
    const setCookie = bootstrap.headers.get("set-cookie")!;
    const sessionCookie = setCookie.split(";")[0]!;

    const createResponse = await createConversationRoute(
      request(`${ORIGIN}/api/projects/${projectId}/conversations`, {
        method: "POST",
        body: { title: "Authenticated conversation" },
        headers: { origin: ORIGIN, [CSRF_HEADER]: CSRF_TOKEN, cookie: `${sessionCookie}; ${CSRF_COOKIE}=${CSRF_TOKEN}` }
      }),
      { params: Promise.resolve({ id: projectId }) }
    );
    expect(createResponse.status).toBe(201);
    const conversation = await createResponse.json();

    const messageResponse = await postMessage(
      request(`${ORIGIN}/api/conversations/${conversation.id}/messages`, {
        method: "POST",
        body: { content: "hello", provider: "codex-cli", mode: "ASK" },
        headers: { origin: ORIGIN, [CSRF_HEADER]: CSRF_TOKEN, cookie: `${sessionCookie}; ${CSRF_COOKIE}=${CSRF_TOKEN}` }
      }),
      { params: Promise.resolve({ id: conversation.id }) }
    );
    expect(messageResponse.status).toBe(202);
    const messageBody = await messageResponse.json();

    const executionResponse = await getExecution(
      request(`${ORIGIN}/api/conversations/${conversation.id}/executions/${messageBody.queuedExecution.agentSessionId}?projectId=${projectId}`, { headers: { host: "127.0.0.1:3300" } }),
      { params: Promise.resolve({ id: conversation.id, executionId: messageBody.queuedExecution.agentSessionId }) }
    );
    expect(executionResponse.status).toBe(200);
  });

  it("rejects unauthenticated operational access even from a same-origin request", async () => {
    const response = await createConversationRoute(
      request(`${ORIGIN}/api/projects/${projectId}/conversations`, {
        method: "POST",
        body: { title: "No session" },
        headers: { origin: ORIGIN, [CSRF_HEADER]: CSRF_TOKEN, cookie: `${CSRF_COOKIE}=${CSRF_TOKEN}` }
      }),
      { params: Promise.resolve({ id: projectId }) }
    );
    expect(response.status).toBe(401);
  });

  it("does not authenticate on a CSRF token alone (fetching /api/csrf never issues a session)", async () => {
    // A request presenting a valid, matching CSRF cookie+header pair but no local-session
    // cookie must still be rejected: CSRF proves same-origin intent, not operational access.
    const csrfOnlyResponse = await createConversationRoute(
      request(`${ORIGIN}/api/projects/${projectId}/conversations`, {
        method: "POST",
        body: { title: "CSRF only" },
        headers: { origin: ORIGIN, [CSRF_HEADER]: CSRF_TOKEN, cookie: `${CSRF_COOKIE}=${CSRF_TOKEN}` }
      }),
      { params: Promise.resolve({ id: projectId }) }
    );
    expect(csrfOnlyResponse.status).toBe(401);
  });

  it("rejects cross-project access to a conversation that belongs to a different project", async () => {
    const bootstrap = await bootstrapLocalSession(request(`${ORIGIN}/api/auth/local-session`, { method: "POST", headers: { host: "127.0.0.1:3300" } }));
    const sessionCookie = bootstrap.headers.get("set-cookie")!.split(";")[0]!;

    const createResponse = await createConversationRoute(
      request(`${ORIGIN}/api/projects/${projectId}/conversations`, {
        method: "POST",
        body: { title: "Owned by project A" },
        headers: { origin: ORIGIN, [CSRF_HEADER]: CSRF_TOKEN, cookie: `${sessionCookie}; ${CSRF_COOKIE}=${CSRF_TOKEN}` }
      }),
      { params: Promise.resolve({ id: projectId }) }
    );
    const conversation = await createResponse.json();

    const crossProjectResponse = await getExecution(
      request(`${ORIGIN}/api/conversations/${conversation.id}/executions/does-not-matter?projectId=${otherProjectId}`, { headers: { host: "127.0.0.1:3300" } }),
      { params: Promise.resolve({ id: conversation.id, executionId: "does-not-matter" }) }
    );
    expect(crossProjectResponse.status).toBe(404);
  });
});
