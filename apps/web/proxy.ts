import type{NextRequest}from"next/server";import{NextResponse}from"next/server";import{CSRF_COOKIE,validateMutationRequest}from"./lib/csrf";import{isLoopbackRequestHeaders}from"@project-relay/shared";
export function proxy(request:NextRequest){
  if(!request.nextUrl.pathname.startsWith("/api/"))return NextResponse.next();
  const loopback=isLoopbackRequestHeaders({host:request.headers.get("host"),forwardedFor:request.headers.get("x-forwarded-for"),forwardedHost:request.headers.get("x-forwarded-host")});
  if(!loopback)return NextResponse.json({error:"This server only accepts loopback connections."},{status:403});
  if(["GET","HEAD","OPTIONS"].includes(request.method))return NextResponse.next();
  const cookieToken=request.cookies.get(CSRF_COOKIE)?.value;const headerToken=request.headers.get("x-csrf-token")??undefined;const allowed=validateMutationRequest({method:request.method,requestOrigin:request.headers.get("origin"),serverOrigin:request.nextUrl.origin,...(cookieToken?{cookieToken}:{}),...(headerToken?{headerToken}:{})});
  return allowed?NextResponse.next():NextResponse.json({error:"Same-origin CSRF validation failed."},{status:403});
}
export const config={matcher:"/api/:path*"};
