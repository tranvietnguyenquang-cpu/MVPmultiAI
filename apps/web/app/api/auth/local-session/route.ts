import { NextRequest, NextResponse } from "next/server";
import { createLocalSession } from "@project-relay/database";
import { isLoopbackNextRequest } from "../../../../lib/loopback";
import { LOCAL_SESSION_COOKIE } from "../../../../lib/local-auth-shared";

export async function POST(request: NextRequest) {
  if (!isLoopbackNextRequest(request)) {
    return NextResponse.json({ error: "This server only accepts loopback connections." }, { status: 403 });
  }

  const session = await createLocalSession();
  const response = NextResponse.json({ ok: true });
  response.cookies.set(LOCAL_SESSION_COOKIE, session.token, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24
  });
  return response;
}
