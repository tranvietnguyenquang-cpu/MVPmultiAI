import { NextRequest, NextResponse } from "next/server";
import { relayV2ApiError } from "../../../../../../lib/relay-v2/api";
import { assertRelayV2Enabled, getRelayV2Orchestrator } from "../../../../../../lib/relay-v2/server";

export async function GET(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertRelayV2Enabled();
    return NextResponse.json(await (await getRelayV2Orchestrator()).listTaskAudit((await params).id));
  } catch (error) {
    return relayV2ApiError(error, "GET /api/v2/tasks/[id]/audit");
  }
}
