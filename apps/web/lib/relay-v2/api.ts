import { NextResponse } from "next/server";
import { HandoffValidationError, InvalidTaskTransitionError } from "@project-relay/relay-v2-domain";
import { RelayV2ConflictError, RelayV2NotFoundError } from "@project-relay/relay-v2-orchestrator";
import { apiErrorResponse, ApiError } from "../api-errors.js";

export function relayV2ApiError(error: unknown, context: string): NextResponse {
  if (error instanceof HandoffValidationError) {
    return NextResponse.json({ error: "Handoff validation failed.", code: "VALIDATION_ERROR", issues: error.issues }, { status: 400 });
  }
  if (error instanceof InvalidTaskTransitionError) return apiErrorResponse(new ApiError("CONFLICT", error.message), context);
  if (error instanceof RelayV2ConflictError) return apiErrorResponse(new ApiError("CONFLICT", error.message), context);
  if (error instanceof RelayV2NotFoundError) return apiErrorResponse(new ApiError("NOT_FOUND", error.message), context);
  return apiErrorResponse(error, context);
}
