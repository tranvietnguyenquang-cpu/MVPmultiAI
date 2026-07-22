import { timingSafeEqual } from "node:crypto";
export const CSRF_COOKIE="project_relay_csrf";
export function validateMutationRequest(input:{method:string;requestOrigin:string|null;serverOrigin:string;cookieToken?:string;headerToken?:string}):boolean{
  if(["GET","HEAD","OPTIONS"].includes(input.method))return true;
  if(!input.requestOrigin||input.requestOrigin!==input.serverOrigin||!input.cookieToken||!input.headerToken)return false;
  const a=Buffer.from(input.cookieToken);const b=Buffer.from(input.headerToken);return a.length===b.length&&timingSafeEqual(a,b);
}
