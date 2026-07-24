import type{NextRequest}from"next/server";import{NextResponse}from"next/server";import{classifyMutationRequest,CSRF_COOKIE,validateMutationRequest}from"./lib/csrf";import{isLoopbackHost,isLoopbackRequestHeaders}from"@project-relay/shared";
// The local-session bootstrap mints the very session cookie every other mutating route's
// CSRF check depends on, so it cannot itself require a pre-existing CSRF token - only
// same-origin is enforced for it here (the route also independently re-checks loopback).
const CSRF_EXEMPT_PATHS=new Set(["/api/auth/local-session"]);
const SAFE_METHODS=new Set(["GET","HEAD","OPTIONS"]);
// Next's own NextRequest.nextUrl.origin always reports "http://localhost:<port>" for this
// app regardless of the Host header actually used to connect, so "localhost" is the one
// canonical browser-facing origin every same-origin check below can ever match against.
const CANONICAL_HOST="localhost";
export function proxy(request:NextRequest){
  const hostHeader=request.headers.get("host");
  const loopback=isLoopbackRequestHeaders({host:hostHeader,forwardedFor:request.headers.get("x-forwarded-for"),forwardedHost:request.headers.get("x-forwarded-host")});
  const hostname=(hostHeader??"").split(":")[0]??"";
  // A safe (GET/HEAD/OPTIONS) request that is genuinely loopback but arrived via a
  // different loopback literal (typically "127.0.0.1", the launcher's historical default)
  // is redirected here, before session bootstrap or any other route ever runs, so the
  // browser's own tab origin becomes "localhost" first and every subsequent same-page
  // fetch's Origin header matches it. Mutating requests are never redirected here: their
  // own CSRF/loopback checks below already reject a mismatched origin exactly as before -
  // this only smooths navigation, it never grants anything a redirect itself couldn't.
  if(loopback&&SAFE_METHODS.has(request.method)&&hostname&&hostname!==CANONICAL_HOST&&isLoopbackHost(hostname)){
    const port=(hostHeader??"").split(":")[1];
    const target=new URL(`${request.nextUrl.pathname}${request.nextUrl.search}`,`${request.nextUrl.protocol}//${CANONICAL_HOST}${port?`:${port}`:""}`);
    // A plain HTTP redirect (NextResponse.redirect, or a manually-set Location header on a
    // 3xx response) gets its Location silently rewritten by Next's own request handling
    // whenever the target matches request.nextUrl.origin - which, per the very quirk this
    // redirect exists to work around, *always* reports "http://localhost:<port>"
    // internally. That collapses our absolute target back down to a bare path, which the
    // browser then resolves against the page it's actually still on (127.0.0.1) - an
    // infinite redirect loop. A tiny same-body HTML document that navigates via
    // `location.replace()` sidesteps Next's own Location-header handling entirely: the
    // browser executes it as ordinary page script, on the real navigation it's actually on.
    const targetJson=JSON.stringify(target.toString());
    const html=`<!doctype html><html><head><meta charset="utf-8"><title>Redirecting…</title></head><body>Redirecting to <a href=${targetJson}>the canonical local origin</a>…<script>location.replace(${targetJson});</script></body></html>`;
    return new NextResponse(html,{status:200,headers:{"content-type":"text/html; charset=utf-8","cache-control":"no-store"}});
  }
  if(!request.nextUrl.pathname.startsWith("/api/"))return NextResponse.next();
  if(!loopback)return NextResponse.json({error:"This server only accepts loopback connections."},{status:403});
  if(SAFE_METHODS.has(request.method))return NextResponse.next();
  const cookieToken=request.cookies.get(CSRF_COOKIE)?.value;const headerToken=request.headers.get("x-csrf-token")??undefined;
  const mutationInput={method:request.method,requestOrigin:request.headers.get("origin"),serverOrigin:request.nextUrl.origin,...(cookieToken?{cookieToken}:{}),...(headerToken?{headerToken}:{})};
  if(CSRF_EXEMPT_PATHS.has(request.nextUrl.pathname)){
    return classifyMutationRequest(mutationInput)==="cross-origin"?NextResponse.json({error:"Cross-origin requests are not permitted."},{status:403}):NextResponse.next();
  }
  return validateMutationRequest(mutationInput)?NextResponse.next():NextResponse.json({error:"Same-origin CSRF validation failed."},{status:403});
}
export const config={matcher:["/((?!_next/static|_next/image|favicon.ico).*)"]};
