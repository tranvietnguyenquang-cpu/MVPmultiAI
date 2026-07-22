import crossSpawn from "cross-spawn";
import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { SAFE_ENVIRONMENT, StreamSafeRedactor, validateWorkspace } from "@project-relay/execution";
import type { TaskCapsuleContent } from "@project-relay/shared";

export type ProviderId = "codex-cli" | "claude-cli";
export type ProviderRole = "IMPLEMENTER" | "REVIEWER" | "VERIFIER";
export type AuthenticationState = "available" | "unavailable" | "unknown";
export type ProviderStatus = { installed: boolean; available: boolean; version?: string; authentication: AuthenticationState; lastChecked: Date; setup: string };
export type AgentSessionInput = { workspace: string; taskId: string; role?: ProviderRole; resumeExternalId?: string };
export type AgentSession = { id: string; providerId: ProviderId; workspace: string; taskId: string; role: ProviderRole; externalId?: string };
export type AgentEvent = { type: "state" | "stdout" | "stderr" | "usage"; message: string; timestamp: Date };
export type UsageReport = { estimated: boolean; inputTokens?: number; outputTokens?: number; costUsd?: number };
export type ConnectionTest = { ok: boolean; output: string; durationMs: number };

export interface CodingProvider {
  readonly id: ProviderId; readonly name: string; readonly defaultRoles: ProviderRole[]; readonly setupInstructions: string;
  detectInstallation(): Promise<boolean>; getVersion(): Promise<string | undefined>; checkAuthentication(): Promise<AuthenticationState>;
  checkAvailability(): Promise<ProviderStatus>; testConnection(signal?: AbortSignal): Promise<ConnectionTest>;
  createSession(input: AgentSessionInput): Promise<AgentSession>; startSession(session: AgentSession, capsule: TaskCapsuleContent, signal?: AbortSignal): Promise<void>;
  sendTask(session: AgentSession, capsule: TaskCapsuleContent, signal?: AbortSignal): Promise<void>;
  streamEvents(sessionId: string): AsyncIterable<AgentEvent>; cancelSession(sessionId: string): Promise<void>;
  resumeSession(session: AgentSession, capsule: TaskCapsuleContent, signal?: AbortSignal): Promise<void>;
  getUsage(sessionId: string): Promise<UsageReport>;
}

type SessionRecord = { events: AgentEvent[]; waiters: Array<() => void>; controller: AbortController; usage: UsageReport; child?: ChildProcess; complete: boolean };
type SpawnFn = typeof crossSpawn;

abstract class CliProvider implements CodingProvider {
  abstract readonly id: ProviderId; abstract readonly name: string; abstract readonly executable: string;
  abstract readonly defaultRoles: ProviderRole[]; abstract readonly setupInstructions: string;
  protected readonly sessions = new Map<string, SessionRecord>();
  constructor(protected readonly spawnProcess: SpawnFn = crossSpawn) {}
  protected async execute(args: string[], input?: string, signal?: AbortSignal, timeoutMs=30_000, maxBytes=32_768): Promise<{code:number|null;output:string;durationMs:number}> {
    const started=Date.now(); const redactor=new StreamSafeRedactor(maxBytes);
    return await new Promise((resolve,reject)=>{
      const child=this.spawnProcess(this.executable,args,{shell:false,windowsHide:true,env:SAFE_ENVIRONMENT});
      child.stdout?.on("data",(chunk:Buffer)=>redactor.append(chunk));child.stderr?.on("data",(chunk:Buffer)=>redactor.append(chunk));
      child.once("error",reject);const abort=()=>child.kill();signal?.addEventListener("abort",abort,{once:true});
      const timer=setTimeout(()=>child.kill(),timeoutMs);child.once("close",code=>{clearTimeout(timer);signal?.removeEventListener("abort",abort);resolve({code,output:redactor.flush(),durationMs:Date.now()-started});});
      child.stdin?.end(input);
    });
  }
  async detectInstallation(){try{return (await this.execute(["--version"],undefined,undefined,10_000)).code===0;}catch{return false;}}
  async getVersion(){try{const result=await this.execute(["--version"],undefined,undefined,10_000);return result.code===0?result.output.trim():undefined;}catch{return undefined;}}
  abstract checkAuthentication():Promise<AuthenticationState>;
  async checkAvailability():Promise<ProviderStatus>{const lastChecked=new Date();const version=await this.getVersion();const installed=Boolean(version);const authentication=installed?await this.checkAuthentication():"unknown";return{installed,available:installed&&authentication==="available",...(version?{version}:{}),authentication,lastChecked,setup:this.setupInstructions};}
  abstract testConnection(signal?:AbortSignal):Promise<ConnectionTest>;
  async createSession(input:AgentSessionInput):Promise<AgentSession>{const workspace=await validateWorkspace(input.workspace);const session:AgentSession={id:randomUUID(),providerId:this.id,workspace,taskId:input.taskId,role:input.role??this.defaultRoles[0]!,...(input.resumeExternalId?{externalId:input.resumeExternalId}:{})};this.sessions.set(session.id,{events:[],waiters:[],controller:new AbortController(),usage:{estimated:true},complete:false});return session;}
  protected prompt(session:AgentSession,capsule:TaskCapsuleContent):string { return [`Role: ${session.role}.`,`Use only the supplied structured state. Do not rely on conversation history.`,`Respect locked decisions and prohibited changes. Report acceptance-criterion evidence explicitly.`,JSON.stringify(capsule,null,2)].join("\n\n"); }
  protected abstract sessionCommand(session:AgentSession,resume:boolean):string[];
  async startSession(session:AgentSession,capsule:TaskCapsuleContent,signal?:AbortSignal){await this.runSession(session,capsule,false,signal);}
  async sendTask(session:AgentSession,capsule:TaskCapsuleContent,signal?:AbortSignal){await this.startSession(session,capsule,signal);}
  async resumeSession(session:AgentSession,capsule:TaskCapsuleContent,signal?:AbortSignal){await this.runSession(session,capsule,true,signal);}
  private async runSession(session:AgentSession,capsule:TaskCapsuleContent,resume:boolean,signal?:AbortSignal){
    const record=this.sessions.get(session.id);if(!record)throw new Error("Unknown provider session.");const prompt=this.prompt(session,capsule);record.usage={estimated:true,inputTokens:Math.ceil(prompt.length/4),outputTokens:0};
    const effective=signal??record.controller.signal;
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    await new Promise<void>((resolve,reject)=>{const child=this.spawnProcess(this.executable,this.sessionCommand(session,resume),{cwd:session.workspace,shell:false,windowsHide:true,env:SAFE_ENVIRONMENT});record.child=child;const out=new StreamSafeRedactor(262_144);const err=new StreamSafeRedactor(65_536);child.stdout?.on("data",(c:Buffer)=>out.append(c));child.stderr?.on("data",(c:Buffer)=>err.append(c));const abort=()=>child.kill();effective.addEventListener("abort",abort,{once:true});child.once("error",reject);child.once("close",code=>{effective.removeEventListener("abort",abort);for(const [type,message] of [["stdout",out.flush()],["stderr",err.flush()]] as const){if(message){record.events.push({type,message,timestamp:new Date()});record.usage.outputTokens=(record.usage.outputTokens??0)+Math.ceil(message.length/4);}}record.complete=true;record.waiters.splice(0).forEach(w=>w());code===0?resolve():reject(new Error(`${this.name} exited with code ${String(code)}.`));});child.stdin?.end(prompt);});
  }
  async *streamEvents(sessionId:string){const record=this.sessions.get(sessionId);if(!record)throw new Error("Unknown provider session.");let cursor=0;while(!record.complete||cursor<record.events.length){while(cursor<record.events.length)yield record.events[cursor++]!;if(!record.complete)await new Promise<void>(resolve=>record.waiters.push(resolve));}}
  async cancelSession(sessionId:string){const record=this.sessions.get(sessionId);if(!record)return;record.controller.abort();record.child?.kill();record.complete=true;record.waiters.splice(0).forEach(w=>w());}
  async getUsage(sessionId:string){return this.sessions.get(sessionId)?.usage??{estimated:true};}
}

export class CodexCliProvider extends CliProvider {
  readonly id="codex-cli" as const;readonly name="Codex CLI";readonly executable="codex";readonly defaultRoles=["IMPLEMENTER"] as ProviderRole[];
  readonly setupInstructions="Install Codex CLI, then authenticate with `codex login`. ProjectRelay never stores or copies CLI credentials.";
  private captureExternalId(session:AgentSession){const record=this.sessions.get(session.id);for(const event of record?.events??[]){for(const line of event.message.split("\n")){try{const value=JSON.parse(line)as{thread_id?:string;threadId?:string};const id=value.thread_id??value.threadId;if(id){session.externalId=id;return;}}catch{}}}}
  override async startSession(session:AgentSession,capsule:TaskCapsuleContent,signal?:AbortSignal){await super.startSession(session,capsule,signal);this.captureExternalId(session);}
  override async resumeSession(session:AgentSession,capsule:TaskCapsuleContent,signal?:AbortSignal){if(!session.externalId)throw new Error("Codex resume requires a captured CLI thread ID.");await super.resumeSession(session,capsule,signal);this.captureExternalId(session);}
  async checkAuthentication(){try{const r=await this.execute(["login","status"],undefined,undefined,15_000);return r.code===0?"available":"unavailable";}catch{return "unknown";}}
  async testConnection(signal?:AbortSignal){const r=await this.execute(["exec","--json","--sandbox","read-only","--skip-git-repo-check","-"],"Reply with exactly CODEX_OK. Do not read or modify files.",signal,60_000,16_384);return{ok:r.code===0&&r.output.includes("CODEX_OK"),output:r.output,durationMs:r.durationMs};}
  protected sessionCommand(session:AgentSession,resume:boolean){return resume&&session.externalId?["exec","resume",session.externalId,"--json","-"]:["exec","--json","--cd",session.workspace,"-"];}
}

const CLAUDE_READ_ONLY_TOOLS=["Read","Glob","Grep","Bash(git status:*)","Bash(git diff:*)","Bash(npm test:*)","Bash(npm run lint:*)","Bash(npm run typecheck:*)","Bash(npm run build:*)"];
export class ClaudeCliProvider extends CliProvider {
  readonly id="claude-cli" as const;readonly name="Claude CLI";readonly executable="claude";readonly defaultRoles=["REVIEWER","VERIFIER"] as ProviderRole[];
  readonly setupInstructions="Install Claude Code, then run `claude auth login`. ProjectRelay uses that local CLI session and never stores credentials.";
  async checkAuthentication(){try{const r=await this.execute(["auth","status","--json"],undefined,undefined,15_000);return r.code===0?"available":"unavailable";}catch{return "unknown";}}
  async testConnection(signal?:AbortSignal){const r=await this.execute(["-p","--output-format","json","--permission-mode","dontAsk","--allowedTools","Read","--disallowedTools","Edit","Write"],"Reply with exactly CLAUDE_OK. Do not use tools or modify files.",signal,60_000,16_384);return{ok:r.code===0&&r.output.includes("CLAUDE_OK"),output:r.output,durationMs:r.durationMs};}
  protected override prompt(session:AgentSession,capsule:TaskCapsuleContent){return [`You are a read-only ${session.role}. Never edit or write files, install packages, commit, push, reset databases, or run migrations. Only Read, Glob, Grep, git status, git diff, npm test, npm run lint, npm run typecheck, and npm run build are permitted. Return structured findings as JSON lines with severity, title, and body.`,super.prompt(session,capsule)].join("\n\n");}
  protected sessionCommand(session:AgentSession,resume:boolean){const args=["-p","--verbose","--output-format","stream-json","--permission-mode","dontAsk","--allowedTools",...CLAUDE_READ_ONLY_TOOLS,"--disallowedTools","Edit","Write","NotebookEdit","WebFetch","WebSearch"];if(resume&&session.externalId)args.push("--resume",session.externalId);else args.push("--session-id",session.id);return args;}
}

export class ProviderRegistry {
  private readonly providers=new Map<ProviderId,CodingProvider>();
  constructor(providers:CodingProvider[]=[new CodexCliProvider(),new ClaudeCliProvider()]){for(const provider of providers)this.providers.set(provider.id,provider);}
  get(id:string):CodingProvider{const provider=this.providers.get(id as ProviderId);if(!provider)throw new Error(`Unknown provider '${id}'.`);return provider;}
  list():CodingProvider[]{return [...this.providers.values()];}
}
export const providerRegistry=new ProviderRegistry();
