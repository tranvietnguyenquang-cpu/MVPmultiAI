import { NextRequest, NextResponse } from "next/server";
import { relayV2ApiError } from "../../../../../../lib/relay-v2/api";
import { getRelayV2ReviewServices, requireRelayV2Read } from "../../../../../../lib/relay-v2/server";

export async function GET(request: NextRequest) {
  try {
    requireRelayV2Read(request);
    const { engine } = await getRelayV2ReviewServices();
    const reviewer = engine.reviewers.require("fake-reviewer");
    return NextResponse.json({ descriptor: reviewer.describe(), health: await reviewer.health() });
  } catch (error) {
    return relayV2ApiError(error, "GET /api/v2/reviewers/fake-reviewer/health");
  }
}
