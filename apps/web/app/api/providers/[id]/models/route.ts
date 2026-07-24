import { NextResponse } from "next/server";
import { prisma } from "@project-relay/database";
import { listModelsForProvider } from "@project-relay/shared";
import { ApiError, apiErrorResponse } from "../../../../../lib/api-errors";

/**
 * Read-only: returns the server-controlled model registry for this provider, merged with
 * the last cached validation result for each (see apps/worker/src/model-health.ts). Never
 * triggers a live probe itself - that only ever happens via the worker, kept fresh within
 * a bounded TTL, and explicitly requested through the sibling refresh route.
 */
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (id !== "codex-cli" && id !== "claude-cli") throw new ApiError("NOT_FOUND", `Unknown provider '${id}'.`);

    const definitions = listModelsForProvider(id);
    const health = await prisma.modelHealth.findMany({ where: { providerId: id } });
    const healthByModelId = new Map(health.map(row => [row.modelId, row]));

    return NextResponse.json({
      providerId: id,
      models: definitions.map(definition => {
        const cached = healthByModelId.get(definition.modelId);
        return {
          modelId: definition.modelId,
          displayName: definition.displayName,
          enabled: definition.enabled,
          supportedModes: definition.supportedModes,
          allowedReasoningEfforts: definition.allowedReasoningEfforts,
          // AVAILABLE only ever reflects an actual observed probe result - absent means
          // "never validated yet", never fabricated as available by default.
          validation: cached ? { status: cached.status, reason: cached.reason, checkedAt: cached.checkedAt } : { status: "UNKNOWN", reason: null, checkedAt: null },
        };
      }),
    });
  } catch (error) {
    return apiErrorResponse(error, "GET /api/providers/[id]/models");
  }
}
