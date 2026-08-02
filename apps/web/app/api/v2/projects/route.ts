import { NextRequest, NextResponse } from "next/server";
import { relayV2ApiError } from "../../../../lib/relay-v2/api";
import { v2ProjectInputSchema } from "../../../../lib/relay-v2/contracts";
import { assertRelayV2Enabled, getRelayV2Orchestrator, requireRelayV2Mutation } from "../../../../lib/relay-v2/server";

export async function GET() {
  try {
    assertRelayV2Enabled();
    return NextResponse.json(await (await getRelayV2Orchestrator()).listProjects());
  } catch (error) {
    return relayV2ApiError(error, "GET /api/v2/projects");
  }
}

export async function POST(request: NextRequest) {
  try {
    await requireRelayV2Mutation(request);
    const input = v2ProjectInputSchema.parse(await request.json());
    return NextResponse.json(await (await getRelayV2Orchestrator()).createProject({ name: input.name, localPath: input.localPath, ...(input.slug ? { slug: input.slug } : {}), ...(input.description ? { description: input.description } : {}) }), { status: 201 });
  } catch (error) {
    return relayV2ApiError(error, "POST /api/v2/projects");
  }
}
