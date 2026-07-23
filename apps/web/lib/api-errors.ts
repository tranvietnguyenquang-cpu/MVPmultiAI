import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { redactSecrets } from "@project-relay/execution";

export type ApiErrorCode = "VALIDATION_ERROR" | "UNAUTHENTICATED" | "FORBIDDEN" | "NOT_FOUND" | "CONFLICT" | "INTERNAL_ERROR";

const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INTERNAL_ERROR: 500
};

/** Thrown deliberately by route handlers for conditions that are safe to describe to the client verbatim (e.g. "conversation not found", "codex-cli is not authenticated"). */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  constructor(code: ApiErrorCode, message: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
  }
}

// Absolute filesystem paths (Windows drive-letter or POSIX) must never reach the
// browser: workspace/repository paths can appear in Prisma, spawn (ENOENT/EPERM),
// and Node fs error messages.
const PATH_PATTERN = /(?:[A-Za-z]:\\|\/)(?:[^\s"'<>]+[\\/])+[^\s"'<>]*/g;
// Postgres/Redis connection strings sometimes surface in raw driver error messages
// even after redactSecrets' broader connection-string pattern (belt and suspenders).
const CONNECTION_STRING_PATTERN = /\b\w+:\/\/[^\s"'<>]*@[^\s"'<>]+/g;

function redactForClient(input: string): string {
  return redactSecrets(input).replace(CONNECTION_STRING_PATTERN, "[REDACTED]").replace(PATH_PATTERN, "[PATH]");
}

/**
 * Converts any thrown value into a stable, client-safe JSON error response with a
 * stable public error code. `ApiError` messages are treated as intentionally
 * user-facing and redacted only as a backstop. Everything else - Prisma errors,
 * spawn/path/connection-string failures, malformed queued-job payloads, any other
 * unexpected exception - is logged in full server-side and replaced with a fixed,
 * generic INTERNAL_ERROR response so raw diagnostics never reach the browser.
 */
export function apiErrorResponse(error: unknown, context: string): NextResponse {
  if (error instanceof ApiError) {
    return NextResponse.json({ error: redactForClient(error.message), code: error.code }, { status: STATUS_BY_CODE[error.code] });
  }
  // Zod validates the request body against a known, closed schema, so its own
  // generated message is inherently safe to show verbatim (it only ever describes
  // shape/constraint mismatches in client-supplied input, never server internals).
  if (error instanceof ZodError) {
    const message = error.issues[0]?.message ?? "Invalid request.";
    return NextResponse.json({ error: message, code: "VALIDATION_ERROR" satisfies ApiErrorCode }, { status: 400 });
  }
  console.error(`[api:${context}]`, error);
  return NextResponse.json({ error: "An unexpected error occurred. Please try again.", code: "INTERNAL_ERROR" satisfies ApiErrorCode }, { status: 500 });
}
