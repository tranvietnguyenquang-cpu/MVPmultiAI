import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
export const CSRF_COOKIE="project_relay_csrf";
export const CSRF_HEADER="x-csrf-token";
export function validateMutationRequest(input:{method:string;requestOrigin:string|null;serverOrigin:string;cookieToken?:string;headerToken?:string}):boolean{
  if(["GET","HEAD","OPTIONS"].includes(input.method))return true;
  if(!input.requestOrigin||input.requestOrigin!==input.serverOrigin||!input.cookieToken||!input.headerToken)return false;
  const a=Buffer.from(input.cookieToken);const b=Buffer.from(input.headerToken);return a.length===b.length&&timingSafeEqual(a,b);
}

export type MutationGate="ok"|"cross-origin"|"unauthenticated";
export function classifyMutationRequest(input:{method:string;requestOrigin:string|null;serverOrigin:string;cookieToken?:string;headerToken?:string}):MutationGate{
  if(["GET","HEAD","OPTIONS"].includes(input.method))return"ok";
  if(!input.requestOrigin||input.requestOrigin!==input.serverOrigin)return"cross-origin";
  return validateMutationRequest(input)?"ok":"unauthenticated";
}
export function classifyRequest(request:NextRequest):MutationGate{
  const cookieToken=request.cookies.get(CSRF_COOKIE)?.value;
  const headerToken=request.headers.get(CSRF_HEADER)??undefined;
  return classifyMutationRequest({
    method:request.method,
    requestOrigin:request.headers.get("origin"),
    serverOrigin:request.nextUrl.origin,
    ...(cookieToken!==undefined?{cookieToken}:{}),
    ...(headerToken!==undefined?{headerToken}:{})
  });
}
