import { NextRequest, NextResponse } from "next/server";
import { relayV2ApiError } from "../../../../../lib/relay-v2/api";
import { getRelayV2ExecutionServices, requireRelayV2Read } from "../../../../../lib/relay-v2/server";
import { v2ExecutionProjectQuerySchema } from "../../../../../lib/relay-v2/contracts";
import { ExecutionNotFoundError } from "@project-relay/relay-v2-execution";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireRelayV2Read(request);
    const projectId = v2ExecutionProjectQuerySchema.parse(request.nextUrl.searchParams.get("projectId"));
    const { engine } = await getRelayV2ExecutionServices();
    const session = await engine.getSession((await params).id);
    if (!session || session.projectId !== projectId) throw new ExecutionNotFoundError("Execution session not found for this project.");
    return NextResponse.json({ session, timeline: await engine.timeline(session.id) });
  } catch (error) {
    return relayV2ApiError(error, "GET /api/v2/executions/[id]");
  }
}
