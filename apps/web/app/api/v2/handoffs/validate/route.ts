import { NextRequest, NextResponse } from "next/server";
import { RELAY_HANDOFF_V1_TEMPLATE } from "@project-relay/relay-v2-domain";
import { relayV2ApiError } from "../../../../../lib/relay-v2/api";
import { v2HandoffValidationRequestSchema } from "../../../../../lib/relay-v2/contracts";
import { assertRelayV2Enabled, getRelayV2Orchestrator, requireRelayV2Mutation } from "../../../../../lib/relay-v2/server";

export async function GET() {
  try {
    assertRelayV2Enabled();
    return NextResponse.json({ version: 1, template: RELAY_HANDOFF_V1_TEMPLATE });
  } catch (error) {
    return relayV2ApiError(error, "GET /api/v2/handoffs/validate");
  }
}

export async function POST(request: NextRequest) {
  try {
    await requireRelayV2Mutation(request);
    const input = v2HandoffValidationRequestSchema.parse(await request.json());
    const result = await (await getRelayV2Orchestrator()).validateHandoff({ text: input.text, format: input.format, ...(input.projectId ? { projectId: input.projectId } : {}), actor: "local-user" });
    return NextResponse.json({ valid: true, format: result.format, normalized: result.normalized, specHash: result.specHash });
  } catch (error) {
    return relayV2ApiError(error, "POST /api/v2/handoffs/validate");
  }
}
