import { NextRequest, NextResponse } from "next/server";
import { relayV2ApiError } from "../../../../lib/relay-v2/api";
import { v2TaskCreateRequestSchema } from "../../../../lib/relay-v2/contracts";
import { assertRelayV2Enabled, getRelayV2Orchestrator, requireRelayV2Mutation } from "../../../../lib/relay-v2/server";

export async function GET(request: NextRequest) {
  try {
    assertRelayV2Enabled();
    const projectId = request.nextUrl.searchParams.get("projectId") ?? undefined;
    const tasks = await (await getRelayV2Orchestrator()).listTasks(projectId);
    return NextResponse.json(tasks);
  } catch (error) {
    return relayV2ApiError(error, "GET /api/v2/tasks");
  }
}

export async function POST(request: NextRequest) {
  try {
    await requireRelayV2Mutation(request);
    const input = v2TaskCreateRequestSchema.parse(await request.json());
    const result = await (await getRelayV2Orchestrator()).createPendingTask({ projectId: input.projectId, normalized: input.normalized, source: input.source, ...(input.externalId ? { externalId: input.externalId } : {}), ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}), actor: "local-user" });
    return NextResponse.json({ task: result.task, duplicate: result.duplicate, idempotencyKey: result.idempotencyKey }, { status: result.duplicate ? 200 : 201 });
  } catch (error) {
    return relayV2ApiError(error, "POST /api/v2/tasks");
  }
}
