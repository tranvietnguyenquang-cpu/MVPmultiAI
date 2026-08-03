import { NextRequest, NextResponse } from "next/server";
import { ReviewNotFoundError } from "@project-relay/relay-v2-reviewer";
import { relayV2ApiError } from "../../../../../../lib/relay-v2/api";
import { v2ReviewProjectQuerySchema } from "../../../../../../lib/relay-v2/contracts";
import { getRelayV2ReviewServices, requireRelayV2Mutation } from "../../../../../../lib/relay-v2/server";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireRelayV2Mutation(request);
    const reviewRequestId = (await params).id;
    const projectId = v2ReviewProjectQuerySchema.parse(request.nextUrl.searchParams.get("projectId"));
    const { engine, runtime } = await getRelayV2ReviewServices();
    const existing = await engine.getReviewRequest(reviewRequestId);
    if (!existing || existing.projectId !== projectId) throw new ReviewNotFoundError("Review request not found for this project.");
    runtime.start();
    const result = await engine.cancelReview(reviewRequestId, "local-user");
    return NextResponse.json(result);
  } catch (error) {
    return relayV2ApiError(error, "POST /api/v2/reviews/[id]/cancel");
  }
}
