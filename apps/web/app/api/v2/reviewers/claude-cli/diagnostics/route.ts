import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { relayV2ApiError } from "../../../../../../lib/relay-v2/api";
import { getRelayV2ReviewServices, requireRelayV2Mutation, requireRelayV2Read } from "../../../../../../lib/relay-v2/server";

// The refresh operates purely on operator configuration (RELAY_V2_CLAUDE_PATH,
// installed CLI state) -- a request body can never influence which
// executable is probed or how, so the only valid body is an empty object.
// Unknown fields (an executable path override, a model/effort selection,
// anything else) are rejected outright rather than silently ignored.
const claudeDiagnosticsRefreshRequestSchema = z.object({}).strict();

// Sanitized diagnostics only: the reviewer descriptor, the latest persisted
// capability diagnostic (displayPath, never a raw executable path or any
// credential/username/home-directory value), and reviewer health. Never
// spawns Claude directly -- only ReviewEngine, through the registered
// ClaudeCliReviewer, ever invokes the real CLI.
export async function GET(request: NextRequest) {
  try {
    requireRelayV2Read(request);
    const { engine } = await getRelayV2ReviewServices();
    const reviewer = engine.reviewers.require("claude-cli");
    return NextResponse.json({
      descriptor: reviewer.describe(),
      health: await reviewer.health(),
      latest: await engine.latestReviewerCapability("claude-cli")
    });
  } catch (error) {
    return relayV2ApiError(error, "GET /api/v2/reviewers/claude-cli/diagnostics");
  }
}

export async function POST(request: NextRequest) {
  try {
    await requireRelayV2Mutation(request);
    claudeDiagnosticsRefreshRequestSchema.parse(await request.json().catch(() => ({})));
    const { engine } = await getRelayV2ReviewServices();
    return NextResponse.json(await engine.refreshReviewerCapabilities("claude-cli"));
  } catch (error) {
    return relayV2ApiError(error, "POST /api/v2/reviewers/claude-cli/diagnostics");
  }
}
