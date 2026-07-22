import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import crossSpawn from "cross-spawn";

type Check={name:string;command:string[];ok:boolean;output:string};
const checks:Check[]=[];
const npm=process.platform==="win32"?"npm.cmd":"npm";
async function run(name:string,args:string[]){return await new Promise<void>(resolve=>{const child=crossSpawn(npm,args,{shell:false,windowsHide:true,env:process.env});let text="";child.stdout?.on("data",chunk=>text+=chunk);child.stderr?.on("data",chunk=>text+=chunk);child.once("close",code=>{checks.push({name,command:[npm,...args],ok:code===0,output:text.slice(-4000)});resolve();});child.once("error",error=>{checks.push({name,command:[npm,...args],ok:false,output:error.message});resolve();});});}
async function main(){await run("typecheck",["run","typecheck"]);await run("lint",["run","lint"]);await run("unit",["run","test:unit"]);await run("integration",["run","test:integration"]);await run("e2e-contract",["run","test:e2e"]);await run("build",["run","build"]);
  const verdict=checks.every(check=>check.ok)?"VERIFIED_WITH_EXTERNAL_BLOCKERS":"FAILED";
  const report={generatedAt:new Date().toISOString(),verdict,checks,externalBlockers:["A real provider-backed workflow requires installed, authenticated Codex and Claude CLIs. Run the optional smoke scripts to verify them; these are intentionally excluded from normal CI."],limitations:["This command validates code and test contracts. The interactive browser workflow is validated separately against disposable infrastructure."]};
  const directory=join(process.cwd(),"artifacts","verification");await mkdir(directory,{recursive:true});await writeFile(join(directory,"latest.json"),JSON.stringify(report,null,2));await writeFile(join(directory,"latest.md"),`# MVP verification\n\nVerdict: **${verdict}**\n\n${checks.map(check=>`- ${check.ok?"PASS":"FAIL"}: ${check.name}`).join("\n")}\n\n## External blockers\n\n${report.externalBlockers.map(item=>`- ${item}`).join("\n")}\n`);if(verdict==="FAILED")process.exitCode=1;}
void main().catch(error=>{console.error(error instanceof Error?error.stack:error);process.exitCode=1;});
