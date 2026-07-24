import { describe,expect,it } from "vitest"; import { approximateTokens,canVerify,commandSpecSchema,compactReviewCapsule,criterionAcceptsEvidence,findLockedDecisionConflicts,getModelDefinition,getProviderModeCapability,isModelSupported,isReasoningEffortAllowed,listModelsForProvider,listProviderModeCapabilities,modelBelongsToProvider,resolveEffectiveModel,resolveExecutionCapability } from "./index.js";
describe("provider/mode capability matrix",()=>{
  const expected:Record<string,"READ_ONLY"|"WORKSPACE_WRITE"|null>={
    "codex-cli:ASK":"READ_ONLY","codex-cli:REVIEW":"READ_ONLY","codex-cli:VERIFY":"READ_ONLY","codex-cli:CONTINUE":"READ_ONLY","codex-cli:IMPLEMENT":"WORKSPACE_WRITE",
    "claude-cli:ASK":"READ_ONLY","claude-cli:REVIEW":"READ_ONLY","claude-cli:VERIFY":"READ_ONLY","claude-cli:CONTINUE":"READ_ONLY","claude-cli:IMPLEMENT":"WORKSPACE_WRITE"
  };
  it("matches the full tested provider/mode matrix exactly",()=>{
    for(const entry of listProviderModeCapabilities())expect(entry.capability,`${entry.providerId}:${entry.mode}`).toBe(expected[`${entry.providerId}:${entry.mode}`]);
    expect(listProviderModeCapabilities()).toHaveLength(10);
  });
  it("enforces ASK, REVIEW, and VERIFY as read-only for both providers",()=>{
    for(const providerId of["codex-cli","claude-cli"]as const)for(const mode of["ASK","REVIEW","VERIFY"]as const)expect(getProviderModeCapability(providerId,mode)).toBe("READ_ONLY");
  });
  it("grants Codex IMPLEMENT workspace-write",()=>{expect(getProviderModeCapability("codex-cli","IMPLEMENT")).toBe("WORKSPACE_WRITE");});
  it("grants Claude IMPLEMENT workspace-write",()=>{expect(getProviderModeCapability("claude-cli","IMPLEMENT")).toBe("WORKSPACE_WRITE");});
  it("rejects an unknown provider or mode",()=>{expect(getProviderModeCapability("gpt-4","ASK")).toBeNull();expect(getProviderModeCapability("codex-cli","CHAT")).toBeNull();});
});
describe("execution capability resolution (CONTINUE inheritance)",()=>{
  it("has Claude CONTINUE inherit workspace-write from the execution being continued",()=>{
    expect(resolveExecutionCapability("claude-cli","CONTINUE","WORKSPACE_WRITE")).toBe("WORKSPACE_WRITE");
  });
  it("has Claude CONTINUE inherit read-only from the execution being continued",()=>{
    expect(resolveExecutionCapability("claude-cli","CONTINUE","READ_ONLY")).toBe("READ_ONLY");
  });
  it("falls back to the read-only matrix default when Claude CONTINUE has nothing to continue",()=>{
    expect(resolveExecutionCapability("claude-cli","CONTINUE",null)).toBe("READ_ONLY");
    expect(resolveExecutionCapability("claude-cli","CONTINUE")).toBe("READ_ONLY");
  });
  it("never lets Claude CONTINUE inherit past the static matrix for non-CONTINUE modes",()=>{
    expect(resolveExecutionCapability("claude-cli","ASK","WORKSPACE_WRITE")).toBe("READ_ONLY");
    expect(resolveExecutionCapability("claude-cli","IMPLEMENT","READ_ONLY")).toBe("WORKSPACE_WRITE");
  });
  it("keeps Codex CONTINUE unchanged: always read-only regardless of the execution being continued",()=>{
    expect(resolveExecutionCapability("codex-cli","CONTINUE","WORKSPACE_WRITE")).toBe("READ_ONLY");
    expect(resolveExecutionCapability("codex-cli","CONTINUE",null)).toBe("READ_ONLY");
  });
});
describe("model registry",()=>{
  it("always lists Default as supported (absence of a model id)",()=>{
    expect(isModelSupported("codex-cli",null)).toBe(true);
    expect(isModelSupported("claude-cli",undefined)).toBe(true);
  });
  it("lists Claude's configured models",()=>{
    const ids=listModelsForProvider("claude-cli").map(m=>m.modelId);
    expect(ids).toEqual(expect.arrayContaining(["sonnet","opus"]));
    for(const model of listModelsForProvider("claude-cli"))expect(model.enabled).toBe(true);
  });
  it("lists Codex's configured models with allowed reasoning efforts",()=>{
    const models=listModelsForProvider("codex-cli");
    expect(models.length).toBeGreaterThan(0);
    for(const model of models)expect(model.allowedReasoningEfforts.length).toBeGreaterThan(0);
  });
  it("rejects a model id absent from the registry, before anything else can happen",()=>{
    expect(isModelSupported("claude-cli","totally-not-a-real-model")).toBe(false);
    expect(isModelSupported("codex-cli","gpt-4-turbo-not-configured")).toBe(false);
  });
  it("rejects a model that belongs to the other provider",()=>{
    expect(modelBelongsToProvider("codex-cli","sonnet")).toBe(false);
    expect(modelBelongsToProvider("claude-cli","o3")).toBe(false);
    expect(modelBelongsToProvider("claude-cli","sonnet")).toBe(true);
    expect(modelBelongsToProvider("codex-cli","o3")).toBe(true);
  });
  it("rejects an unknown provider outright",()=>{
    expect(isModelSupported("gpt-4","sonnet")).toBe(false);
    expect(getModelDefinition("gpt-4","sonnet")).toBeNull();
  });
  it("bounds reasoning effort by the configured model's own capability",()=>{
    const codexModel=listModelsForProvider("codex-cli")[0]!;
    expect(isReasoningEffortAllowed("codex-cli",codexModel.modelId,codexModel.allowedReasoningEfforts[0])).toBe(true);
    expect(isReasoningEffortAllowed("codex-cli",codexModel.modelId,"not-a-real-effort-level")).toBe(false);
    expect(isReasoningEffortAllowed("claude-cli","sonnet","high")).toBe(false);
    expect(isReasoningEffortAllowed("codex-cli",null,"high")).toBe(false);
  });
  it("never requires a reasoning effort when none was requested",()=>{
    expect(isReasoningEffortAllowed("codex-cli","o3",undefined)).toBe(true);
    expect(isReasoningEffortAllowed("codex-cli",null,undefined)).toBe(true);
  });
});
describe("effective model priority chain",()=>{
  it("prefers the explicit execution selection above every other tier",()=>{
    expect(resolveEffectiveModel({explicit:"opus",projectDefault:"sonnet",applicationDefault:"sonnet"})).toEqual({model:"opus",modelSource:"USER_SELECTED"});
  });
  it("falls back to the project default when nothing was explicitly selected",()=>{
    expect(resolveEffectiveModel({projectDefault:"sonnet",applicationDefault:"opus"})).toEqual({model:"sonnet",modelSource:"PROJECT_DEFAULT"});
  });
  it("falls back to the application default when there is no project default",()=>{
    expect(resolveEffectiveModel({applicationDefault:"opus"})).toEqual({model:"opus",modelSource:"SYSTEM_DEFAULT"});
  });
  it("falls all the way through to the provider's own CLI default when nothing is configured anywhere",()=>{
    expect(resolveEffectiveModel({})).toEqual({model:null,modelSource:"PROVIDER_DEFAULT"});
  });
});
describe("verification gate",()=>{it("requires successful evidence for every criterion",()=>{expect(canVerify([{evidence:[{successful:true}]},{evidence:[]}])).toBe(false);expect(canVerify([{evidence:[{successful:true}]},{evidence:[{successful:true}]}])).toBe(true);expect(canVerify([])).toBe(false);});});
describe("token estimate",()=>{it("returns a conservative non-zero approximation",()=>{expect(approximateTokens({hello:"world"})).toBeGreaterThan(0);});});
describe("review capsule",()=>{it("bounds source context",()=>{const capsule={task:{id:"1",title:"t",objective:"o",userRequest:"u"},architectureDecisions:[],codingRules:"x".repeat(5000),sourceContext:[{path:"a",summary:"x".repeat(3000)}],knownIssues:"",acceptanceCriteria:[],latestTestEvidence:[],prohibitedChanges:[]};expect(compactReviewCapsule(capsule).sourceContext[0]?.summary).toHaveLength(2000);});});
describe("policy",()=>{
  it("rejects browser-defined executables",()=>{expect(()=>commandSpecSchema.parse({id:"x",label:"x",executable:"powershell",args:[],category:"safe",evidenceKind:"COMMAND",timeoutMs:1000})).toThrow();});
  it("enforces structured locked decision paths",()=>{expect(findLockedDecisionConflicts([{id:"ADR-1",forbiddenPaths:["src/legacy/**"],requiredPatterns:[]}],["src/legacy/a.ts"])).toEqual(["ADR-1: forbidden path src/legacy/**"]);});
  it("never links evidence without an explicit kind and command mapping",()=>{const criterion={evidenceKinds:["TYPECHECK"],commandIds:["typecheck"]};expect(criterionAcceptsEvidence(criterion,{kind:"GIT_STATUS"})).toBe(false);expect(criterionAcceptsEvidence(criterion,{kind:"TYPECHECK",commandId:"other"})).toBe(false);expect(criterionAcceptsEvidence(criterion,{kind:"TYPECHECK",commandId:"typecheck"})).toBe(true);});
});
