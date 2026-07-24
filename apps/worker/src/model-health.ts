import { prisma } from "@project-relay/database";
import { providerRegistry, type ModelProbe, type ProviderId } from "@project-relay/providers";

/** How long a successful (or any) probe result is trusted before a fresh probe is worth running again - mirrors ProviderHealth's 15-minute auth-check window. */
const VALIDATION_TTL_MS = 15 * 60_000;

/**
 * Mirrors ProviderHealthMonitor's dedup/cache pattern (see provider-health.ts), scoped to
 * a specific (providerId, modelId[, reasoningEffort]) instead of the provider as a whole.
 * Never fabricates availability: every persisted status comes directly from a real
 * probeModel() call (see packages/providers), which itself never claims AVAILABLE without
 * observing the CLI's own success marker.
 */
export class ModelHealthMonitor {
  private readonly active = new Set<string>();

  async probe(providerId: ProviderId, modelId: string, reasoningEffort?: string, force = false): Promise<void> {
    const key = `${providerId}:${modelId}:${reasoningEffort ?? ""}`;
    if (this.active.has(key)) return;
    this.active.add(key);
    try {
      await prisma.modelHealth.upsert({
        where: { providerId_modelId: { providerId, modelId } },
        create: { providerId, modelId, ...(reasoningEffort ? { reasoningEffort } : {}) },
        update: {},
      });
      const current = await prisma.modelHealth.findUniqueOrThrow({ where: { providerId_modelId: { providerId, modelId } } });
      if (!force && current.checkedAt && Date.now() - current.checkedAt.valueOf() < VALIDATION_TTL_MS) return;

      const claimed = await prisma.modelHealth.updateMany({
        where: { providerId, modelId, checkInProgress: false },
        data: { checkInProgress: true, checkStartedAt: new Date() },
      });
      if (!claimed.count) return;
      try {
        const provider = providerRegistry.get(providerId);
        const probe: ModelProbe = await provider.probeModel(modelId, reasoningEffort);
        await this.recordProbe(probe);
      } finally {
        await prisma.modelHealth.update({ where: { providerId_modelId: { providerId, modelId } }, data: { checkInProgress: false, checkStartedAt: null } });
      }
    } finally {
      this.active.delete(key);
    }
  }

  async recordProbe(probe: ModelProbe): Promise<void> {
    await prisma.modelHealth.upsert({
      where: { providerId_modelId: { providerId: probe.providerId, modelId: probe.modelId } },
      create: {
        providerId: probe.providerId,
        modelId: probe.modelId,
        ...(probe.reasoningEffort ? { reasoningEffort: probe.reasoningEffort } : {}),
        status: probe.status,
        reason: probe.reason ?? null,
        checkedAt: probe.checkedAt,
      },
      update: {
        ...(probe.reasoningEffort ? { reasoningEffort: probe.reasoningEffort } : {}),
        status: probe.status,
        reason: probe.reason ?? null,
        checkedAt: probe.checkedAt,
      },
    });
  }

  async startup(): Promise<void> {
    await prisma.modelHealth.updateMany({ where: { checkInProgress: true }, data: { checkInProgress: false, checkStartedAt: null } });
  }
}

export const modelHealthMonitor = new ModelHealthMonitor();
