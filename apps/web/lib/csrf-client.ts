"use client";
import { LOCAL_SESSION_COOKIE } from "./local-auth-shared.js";
function hasLocalSession(){return typeof document!=="undefined"&&document.cookie.split("; ").some(entry=>entry.startsWith(`${LOCAL_SESSION_COOKIE}=`));}
export async function csrfFetch(input:RequestInfo|URL,init:RequestInit={}){if(!hasLocalSession()){const bootstrap=await fetch("/api/auth/local-session",{method:"POST",cache:"no-store"});if(!bootstrap.ok)throw new Error("Could not establish a local session.");}const tokenResponse=await fetch("/api/csrf",{cache:"no-store"});if(!tokenResponse.ok)throw new Error("Could not establish a CSRF session.");const{token}=await tokenResponse.json()as{token:string};const headers=new Headers(init.headers);headers.set("x-csrf-token",token);return fetch(input,{...init,headers});}
