import type { NextRequest } from "next/server";
import { getValidLocalSession } from "@project-relay/database";
import { LOCAL_SESSION_COOKIE } from "./local-auth-shared.js";

export { LOCAL_SESSION_COOKIE };

export async function requireLocalSession(request: NextRequest) {
  const token = request.cookies.get(LOCAL_SESSION_COOKIE)?.value;
  return getValidLocalSession(token);
}
