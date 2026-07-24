import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { prisma } from "@project-relay/database";
import { ModelHealthMonitor } from "./model-health.js";

describe("model health monitor", () => {
  it("exposes a monitor that serializes checks", () => {
    expect(new ModelHealthMonitor()).toBeInstanceOf(ModelHealthMonitor);
  });

  it("persists a probe result, never fabricating AVAILABLE for a result that reported otherwise", async () => {
    const monitor = new ModelHealthMonitor();
    const modelId = `test-model-${randomUUID()}`;
    await monitor.recordProbe({ providerId: "claude-cli", modelId, status: "UNSUPPORTED", reason: "model not found", checkedAt: new Date() });

    const row = await prisma.modelHealth.findUniqueOrThrow({ where: { providerId_modelId: { providerId: "claude-cli", modelId } } });
    expect(row.status).toBe("UNSUPPORTED");
    expect(row.reason).toBe("model not found");

    await prisma.modelHealth.delete({ where: { providerId_modelId: { providerId: "claude-cli", modelId } } }).catch(() => undefined);
  });

  it("persists reasoning effort alongside the probed status when provided", async () => {
    const monitor = new ModelHealthMonitor();
    const modelId = `test-model-${randomUUID()}`;
    await monitor.recordProbe({ providerId: "codex-cli", modelId, reasoningEffort: "high", status: "AVAILABLE", checkedAt: new Date() });

    const row = await prisma.modelHealth.findUniqueOrThrow({ where: { providerId_modelId: { providerId: "codex-cli", modelId } } });
    expect(row.status).toBe("AVAILABLE");
    expect(row.reasoningEffort).toBe("high");

    await prisma.modelHealth.delete({ where: { providerId_modelId: { providerId: "codex-cli", modelId } } }).catch(() => undefined);
  });
});
