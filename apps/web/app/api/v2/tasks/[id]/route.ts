import { NextRequest, NextResponse } from "next/server";
import { ApiError } from "../../../../../lib/api-errors";
import { relayV2ApiError } from "../../../../../lib/relay-v2/api";
import { v2TaskReplaceRequestSchema } from "../../../../../lib/relay-v2/contracts";
import { assertRelayV2Enabled, getRelayV2Orchestrator, requireRelayV2Mutation } from "../../../../../lib/relay-v2/server";

export async function GET(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertRelayV2Enabled();
    const task = await (await getRelayV2Orchestrator()).getTask((await params).id);
    if (!task) throw new ApiError("NOT_FOUND", "Task not found.");
    return NextResponse.json(task);
  } catch (error) {
    return relayV2ApiError(error, "GET /api/v2/tasks/[id]");
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireRelayV2Mutation(request);
    const input = v2TaskReplaceRequestSchema.parse(await request.json());
    return NextResponse.json(await (await getRelayV2Orchestrator()).replaceTaskSpec((await params).id, input.normalized));
  } catch (error) {
    return relayV2ApiError(error, "PATCH /api/v2/tasks/[id]");
  }
}
