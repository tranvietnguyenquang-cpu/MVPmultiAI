import { NextRequest, NextResponse } from "next/server";
import { relayV2ApiError } from "../../../../../../lib/relay-v2/api";
import { v2TaskResolutionSchema } from "../../../../../../lib/relay-v2/contracts";
import { getRelayV2Orchestrator, requireRelayV2Mutation } from "../../../../../../lib/relay-v2/server";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireRelayV2Mutation(request);
    const body = await request.json().catch(() => ({}));
    const { rejected } = v2TaskResolutionSchema.parse(body);
    const task = await (await getRelayV2Orchestrator()).cancelTask((await params).id, "local-user", rejected);
    return NextResponse.json({ task, executionQueued: false });
  } catch (error) {
    return relayV2ApiError(error, "POST /api/v2/tasks/[id]/cancel");
  }
}
