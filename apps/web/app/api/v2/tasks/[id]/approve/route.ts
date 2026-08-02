import { NextRequest, NextResponse } from "next/server";
import { relayV2ApiError } from "../../../../../../lib/relay-v2/api";
import { getRelayV2Orchestrator, requireRelayV2Mutation } from "../../../../../../lib/relay-v2/server";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireRelayV2Mutation(request);
    const result = await (await getRelayV2Orchestrator()).approveTask((await params).id, "local-user");
    return NextResponse.json({ task: result.task, approval: result.approval, executionQueued: false });
  } catch (error) {
    return relayV2ApiError(error, "POST /api/v2/tasks/[id]/approve");
  }
}
