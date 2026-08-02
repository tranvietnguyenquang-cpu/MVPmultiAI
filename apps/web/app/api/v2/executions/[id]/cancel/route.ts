import { NextRequest, NextResponse } from "next/server";
import { ExecutionNotFoundError } from "@project-relay/relay-v2-execution";
import { relayV2ApiError } from "../../../../../../lib/relay-v2/api";
import { v2ExecutionProjectQuerySchema } from "../../../../../../lib/relay-v2/contracts";
import { getRelayV2ExecutionServices, requireRelayV2Mutation } from "../../../../../../lib/relay-v2/server";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireRelayV2Mutation(request);
    const projectId = v2ExecutionProjectQuerySchema.parse(request.nextUrl.searchParams.get("projectId"));
    const sessionId = (await params).id;
    const { engine } = await getRelayV2ExecutionServices();
    const session = await engine.getSession(sessionId);
    if (!session || session.projectId !== projectId) throw new ExecutionNotFoundError("Execution session not found for this project.");
    const result = await engine.cancelSession(sessionId, "local-user");
    return NextResponse.json(result);
  } catch (error) {
    return relayV2ApiError(error, "POST /api/v2/executions/[id]/cancel");
  }
}
