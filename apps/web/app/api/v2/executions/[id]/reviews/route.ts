import { NextRequest, NextResponse } from "next/server";
import { relayV2ApiError } from "../../../../../../lib/relay-v2/api";
import { getRelayV2ReviewServices, requireRelayV2Mutation, requireRelayV2Read } from "../../../../../../lib/relay-v2/server";
import { v2ReviewProjectQuerySchema, v2ReviewRequestSchema } from "../../../../../../lib/relay-v2/contracts";
import { ReviewNotFoundError } from "@project-relay/relay-v2-reviewer";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireRelayV2Mutation(request);
    const input = v2ReviewRequestSchema.parse(await request.json().catch(() => ({})));
    const projectId = v2ReviewProjectQuerySchema.parse(request.nextUrl.searchParams.get("projectId"));
    const { engine, runtime } = await getRelayV2ReviewServices();
    const result = await engine.requestReview((await params).id, projectId, input.reviewerId, "local-user", {
      diagnostic: input.diagnostic, ...(input.reviewerConfig ? { reviewerConfig: input.reviewerConfig } : {})
    });
    runtime.start();
    return NextResponse.json({ reviewRequest: result.reviewRequest, duplicate: result.duplicate }, { status: result.duplicate ? 200 : 201 });
  } catch (error) {
    return relayV2ApiError(error, "POST /api/v2/executions/[id]/reviews");
  }
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireRelayV2Read(request);
    const sessionId = (await params).id;
    const projectId = v2ReviewProjectQuerySchema.parse(request.nextUrl.searchParams.get("projectId"));
    const { engine, runtime } = await getRelayV2ReviewServices();
    // Ownership must be checked against the execution session itself, not derived from
    // whether any ReviewRequest rows happen to exist — a wrong-project or nonexistent
    // execution must be indistinguishable from one with zero reviews.
    const executionProjectId = await engine.getExecutionSessionProject(sessionId);
    if (!executionProjectId || executionProjectId !== projectId) throw new ReviewNotFoundError("Execution session not found for this project.");
    runtime.start();
    const reviews = await engine.listReviewsForExecution(sessionId);
    // Authority-preserving: never collapsed to a plain status/verdict string. See ReviewGateProjection.
    const reviewGate = await engine.reviewGateProjection(sessionId);
    return NextResponse.json({ reviews, reviewGate });
  } catch (error) {
    return relayV2ApiError(error, "GET /api/v2/executions/[id]/reviews");
  }
}
