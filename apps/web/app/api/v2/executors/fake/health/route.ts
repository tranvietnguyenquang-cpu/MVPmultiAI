import { NextRequest, NextResponse } from "next/server";
import { relayV2ApiError } from "../../../../../../lib/relay-v2/api";
import { getRelayV2ExecutionServices, requireRelayV2Read } from "../../../../../../lib/relay-v2/server";

export async function GET(request: NextRequest) {
  try {
    requireRelayV2Read(request);
    const { engine, runtime } = await getRelayV2ExecutionServices();
    return NextResponse.json({ descriptor: engine.executor.describe(), health: await engine.executor.health(), runtime: runtime.status() });
  } catch (error) {
    return relayV2ApiError(error, "GET /api/v2/executors/fake/health");
  }
}
