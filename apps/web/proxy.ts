import type{NextRequest}from"next/server";import{NextResponse}from"next/server";import{classifyMutationRequest,CSRF_COOKIE,validateMutationRequest}from"./lib/csrf";import{isLoopbackRequestHeaders}from"@project-relay/shared";
// The local-session bootstrap mints the very session cookie every other mutating route's
// CSRF check depends on, so it cannot itself require a pre-existing CSRF token - only
// same-origin is enforced for it here (the route also independently re-checks loopback).
const CSRF_EXEMPT_PATHS=new Set(["/api/auth/local-session"]);
export function proxy(request:NextRequest){
  if(!request.nextUrl.pathname.startsWith("/api/"))return NextResponse.next();
  const loopback=isLoopbackRequestHeaders({host:request.headers.get("host"),forwardedFor:request.headers.get("x-forwarded-for"),forwardedHost:request.headers.get("x-forwarded-host")});
  if(!loopback)return NextResponse.json({error:"This server only accepts loopback connections."},{status:403});
  if(["GET","HEAD","OPTIONS"].includes(request.method))return NextResponse.next();
  const cookieToken=request.cookies.get(CSRF_COOKIE)?.value;const headerToken=request.headers.get("x-csrf-token")??undefined;
  const mutationInput={method:request.method,requestOrigin:request.headers.get("origin"),serverOrigin:request.nextUrl.origin,...(cookieToken?{cookieToken}:{}),...(headerToken?{headerToken}:{})};
  if(CSRF_EXEMPT_PATHS.has(request.nextUrl.pathname)){
    return classifyMutationRequest(mutationInput)==="cross-origin"?NextResponse.json({error:"Cross-origin requests are not permitted."},{status:403}):NextResponse.next();
  }
  return validateMutationRequest(mutationInput)?NextResponse.next():NextResponse.json({error:"Same-origin CSRF validation failed."},{status:403});
}
export const config={matcher:"/api/:path*"};
