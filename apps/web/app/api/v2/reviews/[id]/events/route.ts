import { NextRequest, NextResponse } from "next/server";
import { ReviewNotFoundError } from "@project-relay/relay-v2-reviewer";
import { relayV2ApiError } from "../../../../../../lib/relay-v2/api";
import { v2ReviewCursorSchema, v2ReviewProjectQuerySchema } from "../../../../../../lib/relay-v2/contracts";
import { getRelayV2ReviewServices, requireRelayV2Read } from "../../../../../../lib/relay-v2/server";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireRelayV2Read(request);
    const reviewRequestId = (await params).id;
    const projectId = v2ReviewProjectQuerySchema.parse(request.nextUrl.searchParams.get("projectId"));
    const cursor = v2ReviewCursorSchema.parse(request.nextUrl.searchParams.get("cursor") ?? "0");
    const { engine, runtime } = await getRelayV2ReviewServices();
    const reviewRequest = await engine.getReviewRequest(reviewRequestId);
    if (!reviewRequest || reviewRequest.projectId !== projectId) throw new ReviewNotFoundError("Review request not found for this project.");
    runtime.start();
    const events = await engine.listEvents(reviewRequestId, cursor, 200);
    return NextResponse.json({ events });
  } catch (error) {
    return relayV2ApiError(error, "GET /api/v2/reviews/[id]/events");
  }
}
