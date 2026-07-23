import { describe,expect,it } from "vitest"; import { approximateTokens,canVerify,commandSpecSchema,compactReviewCapsule,criterionAcceptsEvidence,findLockedDecisionConflicts,getProviderModeCapability,listProviderModeCapabilities } from "./index.js";
describe("provider/mode capability matrix",()=>{
  const expected:Record<string,"READ_ONLY"|"WORKSPACE_WRITE"|null>={
    "codex-cli:ASK":"READ_ONLY","codex-cli:REVIEW":"READ_ONLY","codex-cli:VERIFY":"READ_ONLY","codex-cli:CONTINUE":"READ_ONLY","codex-cli:IMPLEMENT":"WORKSPACE_WRITE",
    "claude-cli:ASK":"READ_ONLY","claude-cli:REVIEW":"READ_ONLY","claude-cli:VERIFY":"READ_ONLY","claude-cli:CONTINUE":"READ_ONLY","claude-cli:IMPLEMENT":null
  };
  it("matches the full tested provider/mode matrix exactly",()=>{
    for(const entry of listProviderModeCapabilities())expect(entry.capability,`${entry.providerId}:${entry.mode}`).toBe(expected[`${entry.providerId}:${entry.mode}`]);
    expect(listProviderModeCapabilities()).toHaveLength(10);
  });
  it("enforces ASK, REVIEW, and VERIFY as read-only for both providers",()=>{
    for(const providerId of["codex-cli","claude-cli"]as const)for(const mode of["ASK","REVIEW","VERIFY"]as const)expect(getProviderModeCapability(providerId,mode)).toBe("READ_ONLY");
  });
  it("grants Codex IMPLEMENT workspace-write",()=>{expect(getProviderModeCapability("codex-cli","IMPLEMENT")).toBe("WORKSPACE_WRITE");});
  it("rejects Claude IMPLEMENT as unsupported rather than downgrading it",()=>{expect(getProviderModeCapability("claude-cli","IMPLEMENT")).toBeNull();});
  it("rejects an unknown provider or mode",()=>{expect(getProviderModeCapability("gpt-4","ASK")).toBeNull();expect(getProviderModeCapability("codex-cli","CHAT")).toBeNull();});
});
describe("verification gate",()=>{it("requires successful evidence for every criterion",()=>{expect(canVerify([{evidence:[{successful:true}]},{evidence:[]}])).toBe(false);expect(canVerify([{evidence:[{successful:true}]},{evidence:[{successful:true}]}])).toBe(true);expect(canVerify([])).toBe(false);});});
describe("token estimate",()=>{it("returns a conservative non-zero approximation",()=>{expect(approximateTokens({hello:"world"})).toBeGreaterThan(0);});});
describe("review capsule",()=>{it("bounds source context",()=>{const capsule={task:{id:"1",title:"t",objective:"o",userRequest:"u"},architectureDecisions:[],codingRules:"x".repeat(5000),sourceContext:[{path:"a",summary:"x".repeat(3000)}],knownIssues:"",acceptanceCriteria:[],latestTestEvidence:[],prohibitedChanges:[]};expect(compactReviewCapsule(capsule).sourceContext[0]?.summary).toHaveLength(2000);});});
describe("policy",()=>{
  it("rejects browser-defined executables",()=>{expect(()=>commandSpecSchema.parse({id:"x",label:"x",executable:"powershell",args:[],category:"safe",evidenceKind:"COMMAND",timeoutMs:1000})).toThrow();});
  it("enforces structured locked decision paths",()=>{expect(findLockedDecisionConflicts([{id:"ADR-1",forbiddenPaths:["src/legacy/**"],requiredPatterns:[]}],["src/legacy/a.ts"])).toEqual(["ADR-1: forbidden path src/legacy/**"]);});
  it("never links evidence without an explicit kind and command mapping",()=>{const criterion={evidenceKinds:["TYPECHECK"],commandIds:["typecheck"]};expect(criterionAcceptsEvidence(criterion,{kind:"GIT_STATUS"})).toBe(false);expect(criterionAcceptsEvidence(criterion,{kind:"TYPECHECK",commandId:"other"})).toBe(false);expect(criterionAcceptsEvidence(criterion,{kind:"TYPECHECK",commandId:"typecheck"})).toBe(true);});
});
