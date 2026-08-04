import { NextRequest, NextResponse } from "next/server";
import { ReviewNotFoundError } from "@project-relay/relay-v2-reviewer";
import { relayV2ApiError } from "../../../../../lib/relay-v2/api";
import { v2ReviewProjectQuerySchema } from "../../../../../lib/relay-v2/contracts";
import { getRelayV2ReviewServices, requireRelayV2Read } from "../../../../../lib/relay-v2/server";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireRelayV2Read(request);
    const projectId = v2ReviewProjectQuerySchema.parse(request.nextUrl.searchParams.get("projectId"));
    const { engine, runtime } = await getRelayV2ReviewServices();
    const reviewRequest = await engine.getReviewRequest((await params).id);
    if (!reviewRequest || reviewRequest.projectId !== projectId) throw new ReviewNotFoundError("Review request not found for this project.");
    runtime.start();
    const latestInvocation = await engine.latestInvocation(reviewRequest.id);
    return NextResponse.json({ reviewRequest, latestInvocation });
  } catch (error) {
    return relayV2ApiError(error, "GET /api/v2/reviews/[id]");
  }
}
