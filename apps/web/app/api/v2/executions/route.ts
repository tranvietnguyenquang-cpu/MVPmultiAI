import { NextRequest, NextResponse } from "next/server";
import { relayV2ApiError } from "../../../../lib/relay-v2/api";
import { getRelayV2ExecutionServices, requireRelayV2Read } from "../../../../lib/relay-v2/server";
import { v2ExecutionProjectQuerySchema } from "../../../../lib/relay-v2/contracts";

export async function GET(request: NextRequest) {
  try {
    requireRelayV2Read(request);
    const value = request.nextUrl.searchParams.get("projectId");
    const projectId = value ? v2ExecutionProjectQuerySchema.parse(value) : undefined;
    const { engine, runtime } = await getRelayV2ExecutionServices();
    runtime.start();
    return NextResponse.json({ sessions: await engine.listSessions(projectId), runtime: runtime.status() });
  } catch (error) {
    return relayV2ApiError(error, "GET /api/v2/executions");
  }
}
