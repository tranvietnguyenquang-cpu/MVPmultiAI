import { NextRequest, NextResponse } from "next/server";
import { relayV2ApiError } from "../../../../lib/relay-v2/api";
import { getRelayV2ExecutionServices, requireRelayV2Read } from "../../../../lib/relay-v2/server";

export async function GET(request: NextRequest) {
  try {
    requireRelayV2Read(request);
    return NextResponse.json({ leases: await (await getRelayV2ExecutionServices()).engine.listWorkspaceLeases() });
  } catch (error) {
    return relayV2ApiError(error, "GET /api/v2/workspace-leases");
  }
}
