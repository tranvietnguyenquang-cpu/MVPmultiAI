import { NextRequest, NextResponse } from "next/server";
import { relayV2ApiError } from "../../../../../../lib/relay-v2/api";
import { getRelayV2ExecutionServices, requireRelayV2Mutation, requireRelayV2Read } from "../../../../../../lib/relay-v2/server";

export async function GET(request: NextRequest) {
  try {
    requireRelayV2Read(request);
    const { engine, runtime } = await getRelayV2ExecutionServices();
    const executor = engine.executors.require("codex-cli");
    return NextResponse.json({ descriptor: executor.describe(), latest: await engine.latestExecutorCapability("codex-cli"), runtime: runtime.status() });
  } catch (error) {
    return relayV2ApiError(error, "GET /api/v2/executors/codex/diagnostics");
  }
}

export async function POST(request: NextRequest) {
  try {
    await requireRelayV2Mutation(request);
    const { engine } = await getRelayV2ExecutionServices();
    return NextResponse.json(await engine.refreshExecutorCapabilities("codex-cli"));
  } catch (error) {
    return relayV2ApiError(error, "POST /api/v2/executors/codex/diagnostics");
  }
}
