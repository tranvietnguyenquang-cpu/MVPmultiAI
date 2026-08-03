import { NextRequest, NextResponse } from "next/server";
import { relayV2ApiError } from "../../../../../../lib/relay-v2/api";
import { getRelayV2ExecutionServices, requireRelayV2Mutation } from "../../../../../../lib/relay-v2/server";
import { v2ExecutionRequestSchema } from "../../../../../../lib/relay-v2/contracts";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireRelayV2Mutation(request);
    const input = v2ExecutionRequestSchema.parse(await request.json());
    const services = await getRelayV2ExecutionServices();
    const result = await services.engine.requestExecution((await params).id, "local-user", input);
    services.runtime.start();
    return NextResponse.json({ session: result.session, duplicate: result.duplicate, executionQueued: true }, { status: result.duplicate ? 200 : 201 });
  } catch (error) {
    return relayV2ApiError(error, "POST /api/v2/tasks/[id]/executions");
  }
}
