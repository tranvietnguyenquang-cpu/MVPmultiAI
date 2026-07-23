import type { NextRequest } from "next/server";
import { isLoopbackRequestHeaders } from "@project-relay/shared";

export function isLoopbackNextRequest(request: NextRequest): boolean {
  return isLoopbackRequestHeaders({
    host: request.headers.get("host"),
    forwardedFor: request.headers.get("x-forwarded-for"),
    forwardedHost: request.headers.get("x-forwarded-host")
  });
}
