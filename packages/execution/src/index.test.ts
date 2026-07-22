import { execFile } from "node:child_process";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { StreamSafeRedactor, assertAllowedCommand, inspectGit, redactSecrets, resolveInsideWorkspace, resolveServerCommands, runCommand } from "./index.js";
async function gitWorkspace(){const root=await mkdtemp(path.join(tmpdir(),"relay-test-"));await mkdir(path.join(root,".git"));return root;}
describe("execution security",()=>{
  it("redacts common credentials",()=>{const output=redactSecrets("token=abc123 password=hunter2 postgresql://user:pass@host/db");expect(output).not.toMatch(/abc123|hunter2|user:pass/);});
  it("redacts secrets split across stream chunks",()=>{const r=new StreamSafeRedactor();r.append("-----BEGIN PRIVATE KEY-----\nabc");r.append("123\n-----END PRIVATE KEY-----");expect(r.flush()).toBe("[REDACTED]");});
  it("rejects traversal",async()=>{await expect(resolveInsideWorkspace(process.cwd(),"../outside.txt")).rejects.toThrow(/escapes/);});
  it("rejects symlink and junction escapes",async()=>{const outside=await mkdtemp(path.join(tmpdir(),"relay-out-"));const root=await gitWorkspace();await writeFile(path.join(outside,"secret.txt"),"secret");const link=path.join(root,"link");await symlink(outside,link,process.platform==="win32"?"junction":"dir");await expect(resolveInsideWorkspace(root,"link/secret.txt")).rejects.toThrow(/escapes/);});
  it("enforces the server executable allowlist at runtime",()=>{expect(()=>assertAllowedCommand({id:"x",label:"x",executable:"powershell",args:[],category:"safe",evidenceKind:"COMMAND",timeoutMs:1000}as never)).toThrow(/not server-allowed/);});
  it("resolves full command specifications only from server-owned IDs",()=>{expect(resolveServerCommands(["typecheck"])[0]?.args).toEqual(["run","typecheck"]);expect(()=>resolveServerCommands(["attacker-defined"])).toThrow(/Unknown server command/);});
  it("spawns npm safely through the Windows-aware launcher",async()=>{const root=await gitWorkspace();const result=await runCommand({workspace:root,command:{id:"npm:version",label:"npm version",executable:"npm",args:["--version"],category:"safe",evidenceKind:"COMMAND",timeoutMs:30000}});expect(result.exitCode).toBe(0);expect(result.output.trim()).toMatch(/^\d+\./);});
  it("requires approval for destructive command categories",async()=>{const root=await gitWorkspace();const command={id:"node:approved",label:"approved",executable:"node"as const,args:["-e","console.log('ok')"],category:"destructive"as const,evidenceKind:"COMMAND"as const,timeoutMs:30000};await expect(runCommand({workspace:root,command})).rejects.toThrow(/approved/);expect((await runCommand({workspace:root,command,approved:true})).output).toContain("ok");});
  it("captures real git status and diff independently",async()=>{const root=await mkdtemp(path.join(tmpdir(),"relay-git-"));await promisify(execFile)("git",["init"],{cwd:root});const spec=(args:string[])=>runCommand({workspace:root,command:{id:"git:test",label:"git",executable:"git",args,category:"safe",evidenceKind:"COMMAND",timeoutMs:30000}});await writeFile(path.join(root,"a.txt"),"one\n");await spec(["add","a.txt"]);await spec(["-c","user.name=Test","-c","user.email=test@example.com","commit","-m","init"]);await writeFile(path.join(root,"a.txt"),"two\n");const git=await inspectGit(root);expect(git.status).toContain("a.txt");expect(git.diff).toContain("-one");expect(git.diff).toContain("+two");});
});
