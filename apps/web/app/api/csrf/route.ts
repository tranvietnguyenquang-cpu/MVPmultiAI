import{randomBytes}from"node:crypto";import{NextResponse}from"next/server";import{CSRF_COOKIE}from"../../../lib/csrf";
export async function GET(){const token=randomBytes(32).toString("base64url");const response=NextResponse.json({token});response.cookies.set(CSRF_COOKIE,token,{httpOnly:true,sameSite:"strict",secure:process.env.NODE_ENV==="production",path:"/",maxAge:3600});return response;}
