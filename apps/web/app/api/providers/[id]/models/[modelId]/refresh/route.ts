import { NextResponse } from "next/server";
import { getModelDefinition } from "@project-relay/shared";
import { ApiError, apiErrorResponse } from "../../../../../../../lib/api-errors";
import { getModelHealthQueue } from "../../../../../../../lib/redis";

/**
 * Enqueues a fresh model-validation probe for the worker to run (mirrors
 * /api/providers/[id]/refresh) - never invokes a CLI directly from the web process. Only
 * ever queues a modelId that is actually a registered entry for this provider; a browser
 * cannot cause an arbitrary string to reach the worker's probe here.
 */
export async function POST(_: Request, { params }: { params: Promise<{ id: string; modelId: string }> }) {
  try {
    const { id, modelId } = await params;
    if (id !== "codex-cli" && id !== "claude-cli") throw new ApiError("NOT_FOUND", `Unknown provider '${id}'.`);
    const definition = getModelDefinition(id, modelId);
    if (!definition) throw new ApiError("NOT_FOUND", `Unknown model '${modelId}' for provider '${id}'.`);

    await getModelHealthQueue().add("check", { providerId: id, modelId }, { jobId: `model-refresh-${id}-${modelId}`, removeOnComplete: 20, removeOnFail: 20 });
    return NextResponse.json({ queued: true });
  } catch (error) {
    return apiErrorResponse(error, "POST /api/providers/[id]/models/[modelId]/refresh");
  }
}
