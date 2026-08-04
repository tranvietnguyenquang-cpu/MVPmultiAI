import { NextResponse } from "next/server";
import { HandoffValidationError, InvalidTaskTransitionError } from "@project-relay/relay-v2-domain";
import { RelayV2ConflictError, RelayV2NotFoundError } from "@project-relay/relay-v2-orchestrator";
import { ExecutionAuthorityError, ExecutionConflictError, ExecutionNotFoundError } from "@project-relay/relay-v2-execution";
import { ReviewAuthorityError, ReviewConflictError, ReviewNotFoundError } from "@project-relay/relay-v2-reviewer";
import { ClaudeReviewerUnavailableError } from "@project-relay/relay-v2-claude-reviewer";
import { apiErrorResponse, ApiError } from "../api-errors.js";

export function relayV2ApiError(error: unknown, context: string): NextResponse {
  if (error instanceof HandoffValidationError) {
    return NextResponse.json({ error: "Handoff validation failed.", code: "VALIDATION_ERROR", issues: error.issues }, { status: 400 });
  }
  if (error instanceof InvalidTaskTransitionError) return apiErrorResponse(new ApiError("CONFLICT", error.message), context);
  if (error instanceof RelayV2ConflictError) return apiErrorResponse(new ApiError("CONFLICT", error.message), context);
  if (error instanceof RelayV2NotFoundError) return apiErrorResponse(new ApiError("NOT_FOUND", error.message), context);
  if (error instanceof ExecutionAuthorityError) return apiErrorResponse(new ApiError("FORBIDDEN", error.message), context);
  if (error instanceof ExecutionConflictError) return apiErrorResponse(new ApiError("CONFLICT", error.message), context);
  if (error instanceof ExecutionNotFoundError) return apiErrorResponse(new ApiError("NOT_FOUND", error.message), context);
  if (error instanceof ReviewAuthorityError) return apiErrorResponse(new ApiError("FORBIDDEN", error.message), context);
  if (error instanceof ReviewConflictError) return apiErrorResponse(new ApiError("CONFLICT", error.message), context);
  if (error instanceof ReviewNotFoundError) return apiErrorResponse(new ApiError("NOT_FOUND", error.message), context);
  if (error instanceof ClaudeReviewerUnavailableError) return apiErrorResponse(new ApiError("FORBIDDEN", error.message), context);
  return apiErrorResponse(error, context);
}
