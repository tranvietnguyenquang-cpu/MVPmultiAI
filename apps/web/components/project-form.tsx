"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function ProjectForm() {
  const router=useRouter(); const [error,setError]=useState(""); const [busy,setBusy]=useState(false);
  async function submit(event:React.FormEvent<HTMLFormElement>){event.preventDefault();setBusy(true);setError("");const form=new FormData(event.currentTarget);const body={name:form.get("name"),repositoryPath:form.get("repositoryPath"),commands:[{id:"test",label:"Run tests",executable:"npm",args:["test"],category:"safe",evidenceKind:"UNIT_TEST",timeoutMs:600000},{id:"typecheck",label:"Type-check",executable:"npm",args:["run","typecheck"],category:"safe",evidenceKind:"TYPECHECK",timeoutMs:600000},{id:"build",label:"Build",executable:"npm",args:["run","build"],category:"safe",evidenceKind:"BUILD",timeoutMs:600000}]};const response=await fetch("/api/projects",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});const result=await response.json() as {id?:string;error?:string};setBusy(false);if(!response.ok){setError(result.error??"Could not register project.");return}router.push(`/projects/${result.id!}`);router.refresh();}
  return <form className="form" onSubmit={submit}><label>Project name<input name="name" placeholder="Relay core" required /></label><label>Absolute repository path<input name="repositoryPath" placeholder="C:\\work\\my-project" required /></label>{error&&<p className="warn">{error}</p>}<button disabled={busy}>{busy?"Validating repository…":"Register repository"}</button></form>;
}
