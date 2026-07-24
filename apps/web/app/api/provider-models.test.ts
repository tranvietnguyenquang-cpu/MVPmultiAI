import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@project-relay/database";
import { CSRF_COOKIE, CSRF_HEADER } from "../../lib/csrf";
import { LOCAL_SESSION_COOKIE } from "../../lib/local-auth-shared";
import { GET as getModels } from "./providers/[id]/models/route.js";
import { POST as refreshModel } from "./providers/[id]/models/[modelId]/refresh/route.js";
import { PUT as putApplicationSettings, GET as getApplicationSettings } from "./settings/models/route.js";
import { PUT as putProjectDefaults } from "./projects/[id]/model-defaults/route.js";

const ORIGIN = "http://localhost:3300";
const CSRF_TOKEN = "test-model-routes-csrf";
let sessionToken: string;

function jsonRequest(url: string, options: { method?: string; body?: unknown; withCsrf?: boolean; withSession?: boolean } = {}) {
  const headers = new Headers();
  headers.set("content-type", "application/json");
  const cookies: string[] = [];
  if (options.withCsrf !== false) {
    headers.set(CSRF_HEADER, CSRF_TOKEN);
    cookies.push(`${CSRF_COOKIE}=${CSRF_TOKEN}`);
  }
  if (options.withSession !== false) cookies.push(`${LOCAL_SESSION_COOKIE}=${sessionToken}`);
  if (cookies.length) headers.set("cookie", cookies.join("; "));
  headers.set("origin", ORIGIN);
  return new NextRequest(url, {
    method: options.method ?? "GET",
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
}

describe("provider model registry routes", () => {
  beforeAll(async () => {
    const session = await prisma.localSession.create({ data: { token: `test-model-routes-${randomUUID()}` } });
    sessionToken = session.token;
  });

  it("lists the configured models for Claude with an UNKNOWN validation status when never probed", async () => {
    const response = await getModels(jsonRequest(`${ORIGIN}/api/providers/claude-cli/models`), { params: Promise.resolve({ id: "claude-cli" }) });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.providerId).toBe("claude-cli");
    const modelIds = body.models.map((m: { modelId: string }) => m.modelId);
    expect(modelIds).toEqual(expect.arrayContaining(["sonnet", "opus"]));
    for (const model of body.models) expect(model.validation.status).toBe("UNKNOWN");
  });

  it("lists the configured models for Codex with reasoning efforts", async () => {
    const response = await getModels(jsonRequest(`${ORIGIN}/api/providers/codex-cli/models`), { params: Promise.resolve({ id: "codex-cli" }) });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.models.length).toBeGreaterThan(0);
    for (const model of body.models) expect(model.allowedReasoningEfforts.length).toBeGreaterThan(0);
  });

  it("rejects an unknown provider for the models listing", async () => {
    const response = await getModels(jsonRequest(`${ORIGIN}/api/providers/gpt-4/models`), { params: Promise.resolve({ id: "gpt-4" }) });
    expect(response.status).toBe(404);
  });

  it("reflects a cached validation result once one has been recorded", async () => {
    await prisma.modelHealth.upsert({
      where: { providerId_modelId: { providerId: "claude-cli", modelId: "opus" } },
      create: { providerId: "claude-cli", modelId: "opus", status: "AVAILABLE", checkedAt: new Date() },
      update: { status: "AVAILABLE", checkedAt: new Date() },
    });
    const response = await getModels(jsonRequest(`${ORIGIN}/api/providers/claude-cli/models`), { params: Promise.resolve({ id: "claude-cli" }) });
    const body = await response.json();
    const opus = body.models.find((m: { modelId: string }) => m.modelId === "opus");
    expect(opus.validation.status).toBe("AVAILABLE");
    await prisma.modelHealth.delete({ where: { providerId_modelId: { providerId: "claude-cli", modelId: "opus" } } }).catch(() => undefined);
  });

  it("enqueues a refresh only for a modelId that is actually registered for the provider", async () => {
    const ok = await refreshModel(jsonRequest(`${ORIGIN}/api/providers/claude-cli/models/opus/refresh`, { method: "POST" }), { params: Promise.resolve({ id: "claude-cli", modelId: "opus" }) });
    expect(ok.status).toBe(200);

    const rejected = await refreshModel(jsonRequest(`${ORIGIN}/api/providers/claude-cli/models/totally-not-a-real-model/refresh`, { method: "POST" }), { params: Promise.resolve({ id: "claude-cli", modelId: "totally-not-a-real-model" }) });
    expect(rejected.status).toBe(404);
  });

  describe("application-wide default model settings", () => {
    afterEach(async () => {
      await prisma.applicationSettings.deleteMany({ where: { id: "singleton" } });
    });

    it("requires a session and CSRF to change application defaults", async () => {
      const noSession = await putApplicationSettings(jsonRequest(`${ORIGIN}/api/settings/models`, { method: "PUT", body: { defaultClaudeModel: "opus" }, withSession: false }));
      expect(noSession.status).toBe(401);
      const noCsrf = await putApplicationSettings(jsonRequest(`${ORIGIN}/api/settings/models`, { method: "PUT", body: { defaultClaudeModel: "opus" }, withCsrf: false }));
      expect(noCsrf.status).toBe(401);
    });

    it("validates the model against the registry before persisting", async () => {
      const response = await putApplicationSettings(jsonRequest(`${ORIGIN}/api/settings/models`, { method: "PUT", body: { defaultClaudeModel: "totally-not-a-real-model" } }));
      expect(response.status).toBe(400);
      const get = await getApplicationSettings();
      const body = await get.json();
      expect(body.defaultClaudeModel).toBeNull();
    });

    it("persists a valid application default and reflects it on GET", async () => {
      const response = await putApplicationSettings(jsonRequest(`${ORIGIN}/api/settings/models`, { method: "PUT", body: { defaultCodexModel: "o3", defaultCodexReasoningEffort: "high" } }));
      expect(response.status).toBe(200);
      const get = await getApplicationSettings();
      const body = await get.json();
      expect(body.defaultCodexModel).toBe("o3");
      expect(body.defaultCodexReasoningEffort).toBe("high");
    });
  });

  describe("project-level default model settings", () => {
    let projectId: string;
    beforeAll(async () => {
      const project = await prisma.project.create({
        data: { name: `model-defaults-test-${randomUUID()}`, repositoryPath: `/tmp/model-defaults-test-${randomUUID()}`, allowedCommands: [], permittedPaths: [], isVerification: true },
      });
      projectId = project.id;
    });
    afterAll(async () => {
      await prisma.project.delete({ where: { id: projectId } }).catch(() => undefined);
    });

    it("validates and persists a project-level default model", async () => {
      const rejected = await putProjectDefaults(jsonRequest(`${ORIGIN}/api/projects/${projectId}/model-defaults`, { method: "PUT", body: { defaultClaudeModel: "sonnet-turbo-not-real" } }), { params: Promise.resolve({ id: projectId }) });
      expect(rejected.status).toBe(400);

      const accepted = await putProjectDefaults(jsonRequest(`${ORIGIN}/api/projects/${projectId}/model-defaults`, { method: "PUT", body: { defaultClaudeModel: "sonnet" } }), { params: Promise.resolve({ id: projectId }) });
      expect(accepted.status).toBe(200);
      const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
      expect(project.defaultClaudeModel).toBe("sonnet");
    });

    it("rejects changing defaults for a project that does not exist", async () => {
      const response = await putProjectDefaults(jsonRequest(`${ORIGIN}/api/projects/does-not-exist/model-defaults`, { method: "PUT", body: { defaultClaudeModel: "sonnet" } }), { params: Promise.resolve({ id: "does-not-exist" }) });
      expect(response.status).toBe(404);
    });
  });
});
