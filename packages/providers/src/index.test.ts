import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe,expect,it } from "vitest";
import { resolveCliExecutable } from "./executable.js";
import { classifyProviderProbe,ClaudeCliProvider,CodexCliProvider,ProviderRegistry,StaleProviderSessionError } from "./index.js";
const resolver=async(command:"codex"|"claude")=>({command,canonicalPath:`C:\\safe\\${command}.cmd`});
// Mock spawn deliberately ignores executable and argument values.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function mockSpawn(outputs:string[],codes:number[]=[],options:{hold?:boolean}={}){return ((_:string,_args:string[])=>{const child=new EventEmitter()as any;child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();child.kill=()=>{queueMicrotask(()=>child.emit("close",null));return true;};if(!options.hold){const output=outputs.shift()??"";const code=codes.shift()??0;queueMicrotask(()=>{child.stdout.end(output);child.emit("close",code);});}return child;})as any;}

/** Gives fine-grained control over stdout/stderr chunk timing and close, for stream-parsing fixture tests. */
function mockSpawnController(){
  let child:any;
  let resolveReady:()=>void;
  const ready=new Promise<void>(resolve=>{resolveReady=resolve;});
  const spawn=((_:string,_args:string[])=>{
    child=new EventEmitter()as any;
    child.stdout=new PassThrough();
    child.stderr=new PassThrough();
    child.stdin=new PassThrough();
    child.kill=()=>{queueMicrotask(()=>child.emit("close",null));return true;};
    resolveReady();
    return child;
  })as any;
  const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
  return{
    spawn,ready,
    writeStdout:async(chunk:string)=>{child.stdout.write(chunk);await tick();},
    writeStderr:async(chunk:string)=>{child.stderr.write(chunk);await tick();},
    close:async(code:number|null)=>{child.stdout.end();child.stderr.end();await tick();child.emit("close",code);}
  };
}
describe("Windows CLI resolution",()=>{it("resolves canonical .cmd shims without a shell",async()=>{const seen:string[]=[];const resolved=await resolveCliExecutable("codex",{platform:"win32",pathValue:"C:\\bin",accessFile:async candidate=>{seen.push(candidate);if(!candidate.endsWith(".cmd"))throw new Error("missing");},canonicalize:async candidate=>`C:\\canonical\\${candidate.split("\\").pop()}`});expect(seen).toContain("C:\\bin\\codex.cmd");expect(resolved?.canonicalPath).toBe("C:\\canonical\\codex.cmd");});});
describe("provider health probes",()=>{
  it("reports an absent CLI without probing credentials",async()=>{const provider=new CodexCliProvider(mockSpawn([]),async()=>undefined);const health=await provider.refreshHealth();expect(health).toMatchObject({installed:false,authentication:"UNKNOWN",available:false});});
  it("classifies unauthenticated CLI output",async()=>{const provider=new CodexCliProvider(mockSpawn(["authentication required"],[1]),resolver);expect((await provider.probeAuthentication()).authentication).toBe("NOT_AUTHENTICATED");});
  it("recognizes successful Codex and Claude login probes",async()=>{const codex=new CodexCliProvider(mockSpawn(["CODEX_OK"]),resolver);const claude=new ClaudeCliProvider(mockSpawn(['{"result":"CLAUDE_OK"}']),resolver);expect(await codex.testConnection()).toMatchObject({ok:true,markerObserved:true,exitCode:0});expect(await claude.testConnection()).toMatchObject({ok:true,markerObserved:true,exitCode:0});});
  it("captures rate limits and explicit reset timestamps",async()=>{const provider=new ClaudeCliProvider(mockSpawn(['{"error":"rate limit","reset_at":"2030-01-02T03:04:05.000Z"}'],[1]),resolver);const health=await provider.probeAuthentication();expect(health.authentication).toBe("RATE_LIMITED");expect(health.resetAt?.toISOString()).toBe("2030-01-02T03:04:05.000Z");});
  it("does not fabricate quota",async()=>{const provider=new CodexCliProvider(mockSpawn(["CODEX_OK"]),resolver);const health=await provider.probeAuthentication();expect(health.quotaExact).toBe(false);expect(health.remainingPercent).toBeUndefined();expect(health.quotaSource).toBe("CLI_STATUS");});
  it("classifies malformed successful output as unknown",async()=>{const provider=new ClaudeCliProvider(mockSpawn(["not-json and no marker"]),resolver);expect((await provider.probeAuthentication()).authentication).toBe("UNKNOWN");});
  it("classifies timeout without claiming authentication",()=>expect(classifyProviderProbe("",null,"CODEX_AUTH_OK",{timedOut:true,cancelled:false})).toBe("UNKNOWN"));
  it("contains synchronous Windows process-launch failures",async()=>{const provider=new CodexCliProvider((()=>{throw new Error("spawn EPERM");})as any,resolver);const health=await provider.probeAuthentication();expect(health).toMatchObject({authentication:"CLI_ERROR",available:false});});
  it("honors cancellation and does not leak split secrets",async()=>{const controller=new AbortController();const provider=new CodexCliProvider(mockSpawn([],[],{hold:true}),resolver);const pending=provider.probeAuthentication(controller.signal);await new Promise(resolve=>setTimeout(resolve,0));controller.abort();const health=await pending;expect(health.authentication).toBe("UNKNOWN");const redacted=new CodexCliProvider(mockSpawn(["CODEX_OK token=supersecretvalue"]),resolver);expect((await redacted.testConnection()).output).not.toContain("supersecretvalue");});
  it("has stable registry keys",()=>{const registry=new ProviderRegistry([new CodexCliProvider(mockSpawn([]),resolver),new ClaudeCliProvider(mockSpawn([]),resolver)]);expect(registry.get("codex-cli").defaultRoles).toEqual(["IMPLEMENTER"]);expect(registry.get("claude-cli").defaultRoles).toEqual(["REVIEWER","VERIFIER"]);});
  it("uses workspace-write only for Codex sessions granted WORKSPACE_WRITE capability",async()=>{const calls:string[][]=[];const provider=new CodexCliProvider(((command:string,args:string[])=>{calls.push(args);return mockSpawn([""])(command,args);})as any,resolver);const session=await provider.createSession({workspace:"C:\\MVPmultiAI",taskId:"task",capability:"WORKSPACE_WRITE"});await provider.startSession(session,{} as any);expect(calls[0]).toContain("workspace-write");});
  it("uses read-only sandbox for Codex sessions granted READ_ONLY capability",async()=>{const calls:string[][]=[];const provider=new CodexCliProvider(((command:string,args:string[])=>{calls.push(args);return mockSpawn([""])(command,args);})as any,resolver);const session=await provider.createSession({workspace:"C:\\MVPmultiAI",taskId:"task",capability:"READ_ONLY"});await provider.startSession(session,{} as any);expect(calls[0]).toContain("read-only");expect(calls[0]).not.toContain("workspace-write");});
  it("accepts a workspace-write Claude session under explicit server-controlled tool grants, never an unrestricted permission bypass",async()=>{const calls:string[][]=[];const provider=new ClaudeCliProvider(((command:string,args:string[])=>{calls.push(args);return mockSpawn([""])(command,args);})as any,resolver);const session=await provider.createSession({workspace:"C:\\MVPmultiAI",taskId:"task",capability:"WORKSPACE_WRITE"});expect(session.capability).toBe("WORKSPACE_WRITE");await provider.startSession(session,{} as any);expect(calls[0]).toContain("Edit");expect(calls[0]).toContain("Write");expect(calls[0]).not.toContain("--dangerously-skip-permissions");expect(calls[0]).not.toContain("bypassPermissions");});
  it("accepts a read-only Claude session",async()=>{const provider=new ClaudeCliProvider(mockSpawn([""]),resolver);const session=await provider.createSession({workspace:"C:\\MVPmultiAI",taskId:"task",capability:"READ_ONLY"});expect(session.capability).toBe("READ_ONLY");});
});

async function collectEvents(sessionId:string,provider:CodexCliProvider|ClaudeCliProvider){const events:Array<{type:string;message:string}>=[];for await(const item of provider.streamEvents(sessionId))events.push({type:item.type,message:item.message});return events;}
async function newReadOnlySession(provider:CodexCliProvider|ClaudeCliProvider){return provider.createSession({workspace:"C:\\MVPmultiAI",taskId:"task",capability:"READ_ONLY"});}
function assistantText(events:Array<{type:string;message:string}>){return events.filter(e=>e.type==="stdout").map(e=>e.message).join("");}

describe("structured stream parsing: Codex JSONL",()=>{
  const jsonl=[
    '{"type":"session_configured","session_id":"codex-thread-abc123"}',
    '{"type":"agent_message","message":"Hello from "}',
    '{"type":"agent_message","message":"Codex."}',
    '{"type":"token_count","input_tokens":12,"output_tokens":34}',
    '{"type":"task_complete"}'
  ].map(line=>`${line}\n`).join("");

  it("extracts assistant text, session id, usage, and terminal success across a single write",async()=>{
    const ctrl=mockSpawnController();
    const provider=new CodexCliProvider(ctrl.spawn,resolver);
    const session=await newReadOnlySession(provider);
    const run=provider.startSession(session,{} as any);
    await ctrl.ready;
    await ctrl.writeStdout(jsonl);
    await ctrl.close(0);
    await expect(run).resolves.toBeUndefined();
    expect(session.externalId).toBe("codex-thread-abc123");
    const events=await collectEvents(session.id,provider);
    expect(assistantText(events)).toBe("Hello from Codex.");
    const usageEvent=events.find(e=>e.type==="usage");
    expect(usageEvent).toBeDefined();
    expect(JSON.parse(usageEvent!.message)).toMatchObject({inputTokens:12,outputTokens:34});
  });

  it("reassembles the same result across arbitrary byte-level chunk boundaries, including mid-line splits",async()=>{
    const ctrl=mockSpawnController();
    const provider=new CodexCliProvider(ctrl.spawn,resolver);
    const session=await newReadOnlySession(provider);
    const run=provider.startSession(session,{} as any);
    await ctrl.ready;
    for(let i=0;i<jsonl.length;i+=7)await ctrl.writeStdout(jsonl.slice(i,i+7));
    await ctrl.close(0);
    await expect(run).resolves.toBeUndefined();
    expect(session.externalId).toBe("codex-thread-abc123");
    expect(assistantText(await collectEvents(session.id,provider))).toBe("Hello from Codex.");
  });

  it("ignores a malformed JSON line without crashing and still extracts the surrounding valid lines",async()=>{
    const ctrl=mockSpawnController();
    const provider=new CodexCliProvider(ctrl.spawn,resolver);
    const session=await newReadOnlySession(provider);
    const run=provider.startSession(session,{} as any);
    await ctrl.ready;
    await ctrl.writeStdout('{"type":"session_configured","session_id":"codex-thread-1"}\n');
    await ctrl.writeStdout("{not valid json at all\n");
    await ctrl.writeStdout('{"type":"agent_message","message":"still works"}\n{"type":"task_complete"}\n');
    await ctrl.close(0);
    await expect(run).resolves.toBeUndefined();
    const events=await collectEvents(session.id,provider);
    expect(assistantText(events)).toBe("still works");
    expect(events.some(e=>e.type==="stderr"&&/unparseable/i.test(e.message))).toBe(true);
  });

  it("falls back safely to the exit code when the stream never reports a terminal event",async()=>{
    const ctrl=mockSpawnController();
    const provider=new CodexCliProvider(ctrl.spawn,resolver);
    const session=await newReadOnlySession(provider);
    const run=provider.startSession(session,{} as any);
    await ctrl.ready;
    await ctrl.writeStdout('{"type":"session_configured","session_id":"codex-thread-2"}\n{"type":"agent_message","message":"partial answer, no completion marker"}\n');
    await ctrl.close(0);
    await expect(run).resolves.toBeUndefined();
    expect(assistantText(await collectEvents(session.id,provider))).toBe("partial answer, no completion marker");
  });

  it("rejects with the sanitized structured error reason even when the process exits 0",async()=>{
    const ctrl=mockSpawnController();
    const provider=new CodexCliProvider(ctrl.spawn,resolver);
    const session=await newReadOnlySession(provider);
    const run=provider.startSession(session,{} as any);
    await ctrl.ready;
    await ctrl.writeStdout('{"type":"error","message":"Codex refused the request: quota exceeded."}\n');
    await ctrl.close(0);
    await expect(run).rejects.toThrow(/quota exceeded/);
  });

  it("bounds a single runaway line without a newline instead of buffering it forever, then recovers",async()=>{
    const ctrl=mockSpawnController();
    const provider=new CodexCliProvider(ctrl.spawn,resolver);
    const session=await newReadOnlySession(provider);
    const run=provider.startSession(session,{} as any);
    await ctrl.ready;
    await ctrl.writeStdout("x".repeat(200_000));
    await ctrl.writeStdout('\n{"type":"agent_message","message":"after the giant line"}\n{"type":"task_complete"}\n');
    await ctrl.close(0);
    await expect(run).resolves.toBeUndefined();
    const events=await collectEvents(session.id,provider);
    expect(events.some(e=>e.type==="stderr"&&/truncated/i.test(e.message))).toBe(true);
    expect(assistantText(events)).toBe("after the giant line");
  });

  it("keeps stderr and structured stdout separated when they interleave",async()=>{
    const ctrl=mockSpawnController();
    const provider=new CodexCliProvider(ctrl.spawn,resolver);
    const session=await newReadOnlySession(provider);
    const run=provider.startSession(session,{} as any);
    await ctrl.ready;
    await ctrl.writeStdout('{"type":"session_configured","session_id":"codex-thread-3"}\n');
    await ctrl.writeStderr("some real process diagnostic noise\n");
    await ctrl.writeStdout('{"type":"agent_message","message":"clean answer"}\n{"type":"task_complete"}\n');
    await ctrl.close(0);
    await expect(run).resolves.toBeUndefined();
    const events=await collectEvents(session.id,provider);
    expect(assistantText(events)).toBe("clean answer");
    expect(events.some(e=>e.type==="stderr"&&e.message.includes("some real process diagnostic noise"))).toBe(true);
  });

  it("classifies a stale resumed session distinctly so the caller can fall back safely",async()=>{
    const ctrl=mockSpawnController();
    const provider=new CodexCliProvider(ctrl.spawn,resolver);
    const session=await newReadOnlySession(provider);
    session.externalId="codex-thread-stale";
    const run=provider.resumeSession(session,{} as any);
    await ctrl.ready;
    await ctrl.writeStdout('{"type":"error","message":"No session found with id codex-thread-stale."}\n');
    await ctrl.close(1);
    await expect(run).rejects.toBeInstanceOf(StaleProviderSessionError);
  });

  it("does not misclassify the same stale-sounding message as a resume failure on a fresh (non-resume) run",async()=>{
    const ctrl=mockSpawnController();
    const provider=new CodexCliProvider(ctrl.spawn,resolver);
    const session=await newReadOnlySession(provider);
    const run=provider.startSession(session,{} as any);
    await ctrl.ready;
    await ctrl.writeStdout('{"type":"error","message":"No session found with id codex-thread-stale."}\n');
    await ctrl.close(1);
    let caught:unknown;
    await run.catch(error=>{caught=error;});
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(StaleProviderSessionError);
  });
});

describe("structured stream parsing: Claude stream-json",()=>{
  it("extracts the authoritative final result text instead of the partial streamed deltas",async()=>{
    const ctrl=mockSpawnController();
    const provider=new ClaudeCliProvider(ctrl.spawn,resolver);
    const session=await newReadOnlySession(provider);
    const run=provider.startSession(session,{} as any);
    await ctrl.ready;
    await ctrl.writeStdout('{"type":"system","subtype":"init","session_id":"claude-thread-xyz"}\n');
    await ctrl.writeStdout('{"type":"assistant","message":{"content":[{"type":"text","text":"partial deltas that should be superseded"}]},"session_id":"claude-thread-xyz"}\n');
    await ctrl.writeStdout('{"type":"result","subtype":"success","session_id":"claude-thread-xyz","is_error":false,"result":"the complete final answer","usage":{"input_tokens":5,"output_tokens":9}}\n');
    await ctrl.close(0);
    await expect(run).resolves.toBeUndefined();
    expect(session.externalId).toBe("claude-thread-xyz");
    const events=await collectEvents(session.id,provider);
    expect(assistantText(events)).toBe("the complete final answer");
    const usageEvent=events.find(e=>e.type==="usage");
    expect(JSON.parse(usageEvent!.message)).toMatchObject({inputTokens:5,outputTokens:9});
  });

  it("reassembles across arbitrary chunk boundaries",async()=>{
    const full=[
      '{"type":"system","subtype":"init","session_id":"claude-thread-chunked"}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"ignored delta"}]}}',
      '{"type":"result","subtype":"success","is_error":false,"result":"final chunked answer","usage":{"input_tokens":1,"output_tokens":2}}'
    ].map(line=>`${line}\n`).join("");
    const ctrl=mockSpawnController();
    const provider=new ClaudeCliProvider(ctrl.spawn,resolver);
    const session=await newReadOnlySession(provider);
    const run=provider.startSession(session,{} as any);
    await ctrl.ready;
    for(let i=0;i<full.length;i+=9)await ctrl.writeStdout(full.slice(i,i+9));
    await ctrl.close(0);
    await expect(run).resolves.toBeUndefined();
    expect(session.externalId).toBe("claude-thread-chunked");
    expect(assistantText(await collectEvents(session.id,provider))).toBe("final chunked answer");
  });

  it("rejects with the sanitized error reason when the result reports is_error even on exit code 0",async()=>{
    const ctrl=mockSpawnController();
    const provider=new ClaudeCliProvider(ctrl.spawn,resolver);
    const session=await newReadOnlySession(provider);
    const run=provider.startSession(session,{} as any);
    await ctrl.ready;
    await ctrl.writeStdout('{"type":"result","subtype":"error_during_execution","is_error":true,"session_id":"claude-thread-err","result":"claude failure text"}\n');
    await ctrl.close(0);
    await expect(run).rejects.toThrow(/claude failure text/);
  });

  it("ignores a malformed line and still completes from the valid result event",async()=>{
    const ctrl=mockSpawnController();
    const provider=new ClaudeCliProvider(ctrl.spawn,resolver);
    const session=await newReadOnlySession(provider);
    const run=provider.startSession(session,{} as any);
    await ctrl.ready;
    await ctrl.writeStdout("not json\n");
    await ctrl.writeStdout('{"type":"result","subtype":"success","is_error":false,"result":"recovered answer"}\n');
    await ctrl.close(0);
    await expect(run).resolves.toBeUndefined();
    const events=await collectEvents(session.id,provider);
    expect(assistantText(events)).toBe("recovered answer");
    expect(events.some(e=>e.type==="stderr"&&/unparseable/i.test(e.message))).toBe(true);
  });
});
