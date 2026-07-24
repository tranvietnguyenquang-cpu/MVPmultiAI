import { createHash } from "node:crypto";
import { getProviderModeCapability, isModelSupported, isReasoningEffortAllowed, resolveEffectiveModel, resolveExecutionCapability, type ExecutionCapability, type ModelSource as SharedModelSource } from "@project-relay/shared";
import { Prisma, prisma } from "./index.js";
import { createOutboxEventWithClient } from "./outbox-service.js";
const HANDOFF_MAX_BYTES=32_768;
function canonical(value:unknown):string{if(Array.isArray(value))return`[${value.map(canonical).join(",")}]`;if(value&&typeof value==="object")return`{${Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>`${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;return JSON.stringify(value);}
export const handoffChecksum=(value:unknown)=>createHash("sha256").update(canonical(value)).digest("hex");
type HandoffCapsuleInput={conversationId:string;fromProviderId:string;toProviderId:string;fromModel?:string|null;toModel?:string|null;objective:string;relevantDecisions:object;filesChanged:object;gitBaseline:object;gitDiffSummary:string;tests:object;unresolvedIssues:object;acceptedFindings:object;sourceMessageRange:object};

/** Handoff version is allocated via an atomic row-locked increment on the conversation, never by counting existing rows. */
async function createHandoffCapsuleWithClient(client:Prisma.TransactionClient,input:HandoffCapsuleInput){
  const bounded={...input,gitDiffSummary:input.gitDiffSummary.slice(0,HANDOFF_MAX_BYTES)};
  if(Buffer.byteLength(canonical(bounded))>HANDOFF_MAX_BYTES)throw new Error("Handoff capsule exceeds the bounded payload size.");
  const conversation=await client.conversation.update({where:{id:input.conversationId},data:{handoffSequence:{increment:1}}});
  const payload={...bounded,version:conversation.handoffSequence};
  return client.handoffCapsule.create({data:{...payload,checksum:handoffChecksum(payload)}});
}

export const createConversation=(projectId:string,title:string)=>prisma.conversation.create({data:{projectId,title}});
export const listProjectConversations=(projectId:string)=>prisma.conversation.findMany({where:{projectId},orderBy:{updatedAt:"desc"}});
export const getConversationWithDetails=(id:string)=>prisma.conversation.findUnique({where:{id},include:{messages:{orderBy:[{createdAt:"asc"},{id:"asc"}]},providerSessions:{orderBy:[{startedAt:"asc"},{id:"asc"}]},handoffCapsules:{orderBy:{version:"asc"}},routingDecisions:{orderBy:[{createdAt:"asc"},{id:"asc"}]}}});
export const listConversationMessages=(conversationId:string)=>prisma.conversationMessage.findMany({where:{conversationId},orderBy:[{createdAt:"asc"},{id:"asc"}]});
export const createUserMessage=(conversationId:string,content:string,mode:"ASK"|"IMPLEMENT"|"REVIEW"|"CONTINUE"|"VERIFY",taskId?:string)=>prisma.conversationMessage.create({data:{conversationId,role:"USER",mode,content,status:"COMPLETED",...(taskId?{taskId}:{})}});
export const createAssistantMessage=(input:{conversationId:string;providerId:string;providerSessionId?:string;mode:"ASK"|"IMPLEMENT"|"REVIEW"|"CONTINUE"|"VERIFY";content:string;handoffCapsuleId?:string;taskId?:string})=>prisma.conversationMessage.create({data:{...input,role:"ASSISTANT",status:"COMPLETED"}});
export const getOrCreateProviderSession=(conversationId:string,providerId:string)=>prisma.$transaction(async tx=>{const existing=await tx.providerSession.findFirst({where:{conversationId,providerId,status:"RUNNING"},orderBy:{startedAt:"desc"}});return existing??tx.providerSession.create({data:{conversationId,providerId,status:"RUNNING",startedAt:new Date()}});});
export const closeProviderSession=(id:string,status:"COMPLETED"|"CANCELLED"|"FAILED")=>prisma.providerSession.update({where:{id},data:{status,endedAt:new Date()}});
export const createRoutingDecision=(conversationId:string,selectedProviderId:string,reason:string,providerHealthSnapshot:object,requestedProviderId?:string)=>prisma.routingDecision.create({data:{conversationId,selectedProviderId,reason,providerHealthSnapshot,...(requestedProviderId?{requestedProviderId}:{})}});
export const createHandoffCapsule=(input:HandoffCapsuleInput)=>prisma.$transaction(tx=>createHandoffCapsuleWithClient(tx,input));

export async function getProviderHealthSnapshot(providerIds:string[]){const rows=await prisma.providerHealth.findMany({where:{providerId:{in:providerIds}}});const byId=new Map(rows.map(row=>[row.providerId,row]));const snapshot:Record<string,{installed:boolean;authentication:string;available:boolean}>={};for(const providerId of providerIds){const row=byId.get(providerId);snapshot[providerId]=row?{installed:row.installed,authentication:row.authentication,available:row.available}:{installed:false,authentication:"UNKNOWN",available:false};}return snapshot;}

export const getPreviousAssistantMessage=(conversationId:string)=>prisma.conversationMessage.findFirst({where:{conversationId,role:"ASSISTANT"},orderBy:[{createdAt:"desc"},{id:"desc"}]});

export async function findProjectTask(taskId:string,projectId:string){const task=await prisma.task.findUnique({where:{id:taskId},select:{id:true,projectId:true}});return task&&task.projectId===projectId?task:null;}

type ConversationMode="ASK"|"IMPLEMENT"|"REVIEW"|"CONTINUE"|"VERIFY";
function agentSessionPurpose(mode:ConversationMode):"IMPLEMENTATION"|"REVIEW"|"VERIFICATION"{if(mode==="REVIEW")return"REVIEW";if(mode==="VERIFY")return"VERIFICATION";return"IMPLEMENTATION";}

/**
 * Resolves and validates the effective model/reasoning-effort for a queued execution
 * through the documented priority chain (explicit selection -> project default ->
 * application default -> provider CLI default), then rejects before any row is written
 * if the resolved model doesn't belong to (or isn't enabled for) the selected provider,
 * or the reasoning effort isn't one the resolved model actually accepts. `explicitModel`/
 * `explicitReasoningEffort` are the raw, schema-bounded-but-not-yet-registry-validated
 * browser values - never trusted directly for anything beyond this resolution.
 */
async function resolveModelSelection(tx:Prisma.TransactionClient,input:{providerId:string;projectId:string;explicitModel?:string|null|undefined;explicitReasoningEffort?:string|null|undefined}):Promise<{model:string|null;reasoningEffort:string|null;modelSource:SharedModelSource}>{
  const [project,appSettings]=await Promise.all([
    tx.project.findUniqueOrThrow({where:{id:input.projectId},select:{defaultClaudeModel:true,defaultCodexModel:true,defaultCodexReasoningEffort:true}}),
    tx.applicationSettings.findUnique({where:{id:"singleton"}})
  ]);
  const isClaudeProvider=input.providerId==="claude-cli";
  const projectDefaultModel=isClaudeProvider?project.defaultClaudeModel:project.defaultCodexModel;
  const applicationDefaultModel=isClaudeProvider?appSettings?.defaultClaudeModel??null:appSettings?.defaultCodexModel??null;
  const{model,modelSource}=resolveEffectiveModel({explicit:input.explicitModel,projectDefault:projectDefaultModel,applicationDefault:applicationDefaultModel});
  // isModelSupported already implies "registered for this provider and enabled" - a model
  // id that happens to be valid for the *other* provider fails this exactly the same way
  // as one that is not registered anywhere, which is the correct outcome either way: it
  // is not usable for this execution's selected provider.
  if(model&&!isModelSupported(input.providerId,model))throw new Error(`${input.providerId} does not support model '${model}'.`);

  // Reasoning effort follows the same priority chain, but only ever for Codex (Claude's
  // registry entries carry no allowedReasoningEfforts, so any effort would already be
  // rejected below) and only ever alongside an actual model selection.
  const projectDefaultEffort=isClaudeProvider?null:project.defaultCodexReasoningEffort;
  const applicationDefaultEffort=isClaudeProvider?null:appSettings?.defaultCodexReasoningEffort??null;
  const reasoningEffort=input.explicitReasoningEffort??projectDefaultEffort??applicationDefaultEffort??null;
  if(reasoningEffort&&!isReasoningEffortAllowed(input.providerId,model,reasoningEffort))throw new Error(`${input.providerId} model '${model??"default"}' does not support reasoning effort '${reasoningEffort}'.`);

  return{model,reasoningEffort,modelSource};
}

export type QueueConversationMessageInput={
  conversationId:string;
  projectId:string;
  content:string;
  mode:ConversationMode;
  taskId?:string;
  selectedProviderId:string;
  requestedProviderId?:string;
  /** Raw browser-supplied model id/alias, or omitted/null for "Default". Schema-bounded but not yet registry-validated - see resolveModelSelection. */
  requestedModel?:string|null;
  requestedReasoningEffort?:string|null;
  reason:string;
  providerHealthSnapshot:Record<string,unknown>;
  previousAssistantMessage:{id:string;providerId:string|null}|null;
  /** Client-generated (or server-assigned) key. Resubmitting the same key for the same conversation returns the original result instead of creating new work. */
  idempotencyKey:string;
};

export async function queueConversationMessage(input:QueueConversationMessageInput){
  if(!getProviderModeCapability(input.selectedProviderId,input.mode))throw new Error(`${input.selectedProviderId} does not support ${input.mode} execution.`);
  return prisma.$transaction(async tx=>{
    // Acquire an exclusive row lock on the conversation before doing anything else. This
    // serializes every concurrent submission against the same conversation (same-provider
    // or provider-switch alike), which is also what makes the ProviderSession
    // find-or-create below and handoff version allocation race-free without relying on
    // constraint-violation retries.
    await tx.conversation.update({where:{id:input.conversationId},data:{sequence:{increment:1}}});

    const existingMessage=await tx.conversationMessage.findFirst({where:{conversationId:input.conversationId,idempotencyKey:input.idempotencyKey}});
    if(existingMessage){
      const agentSession=await tx.agentSession.findFirst({where:{userMessageId:existingMessage.id}});
      if(!agentSession)throw new Error("Duplicate submission references a missing execution.");
      const[routingDecision,providerSession,handoffCapsule]=await Promise.all([
        tx.routingDecision.findFirst({where:{userMessageId:existingMessage.id}}),
        agentSession.providerSessionId?tx.providerSession.findUnique({where:{id:agentSession.providerSessionId}}):Promise.resolve(null),
        existingMessage.handoffCapsuleId?tx.handoffCapsule.findUnique({where:{id:existingMessage.handoffCapsuleId}}):Promise.resolve(null)
      ]);
      return{duplicate:true as const,userMessage:existingMessage,routingDecision,providerSession,handoffCapsule,agentSession,taskId:agentSession.taskId,outboxEvent:null};
    }

    // Model resolution happens before any row is written: an unsupported model or
    // reasoning effort must reject the whole submission before queueing, never partially.
    const{model:effectiveModel,reasoningEffort:effectiveReasoningEffort,modelSource}=await resolveModelSelection(tx,{providerId:input.selectedProviderId,projectId:input.projectId,explicitModel:input.requestedModel,explicitReasoningEffort:input.requestedReasoningEffort});

    // The most recent ProviderSession for this exact provider in this conversation
    // (any status) - used both to decide reuse-eligibility below and, if the model
    // differs, as the "from" side of a model-switch handoff.
    const latestSessionForProvider=await tx.providerSession.findFirst({where:{conversationId:input.conversationId,providerId:input.selectedProviderId},orderBy:{startedAt:"desc"}});
    // A session is only reuse-eligible if it is still RUNNING *and* pinned to the exact
    // same model this request resolved to - continuing under a different model must
    // never silently reuse an incompatible session (see resolvedModel on ProviderSession).
    const existingSession=latestSessionForProvider&&latestSessionForProvider.status==="RUNNING"&&latestSessionForProvider.resolvedModel===effectiveModel
      ?latestSessionForProvider
      :null;
    // A partial unique index enforces at most one RUNNING ProviderSession per
    // (conversationId, providerId): a still-RUNNING session that isn't reuse-eligible
    // (wrong model) must be retired before the new one can be created, not left dangling.
    if(!existingSession&&latestSessionForProvider?.status==="RUNNING"){
      await tx.providerSession.update({where:{id:latestSessionForProvider.id},data:{status:"COMPLETED",endedAt:new Date()}});
    }
    const providerSession=existingSession??await tx.providerSession.create({data:{conversationId:input.conversationId,providerId:input.selectedProviderId,status:"RUNNING",startedAt:new Date(),resolvedModel:effectiveModel,...(effectiveReasoningEffort?{reasoningEffort:effectiveReasoningEffort}:{})}});

    const taskId=input.taskId??(await tx.task.create({data:{projectId:input.projectId,title:input.content.slice(0,160)||"Conversation message",userRequest:input.content,objective:input.content.slice(0,2_000),relevantFiles:[],constraints:[],prohibitedChanges:[],assignedProvider:input.selectedProviderId}})).id;

    // CONTINUE inheritance (Claude only - see resolveExecutionCapability) needs the
    // capability of the most recent prior execution for this exact provider in this
    // conversation, never a browser-supplied value.
    const continuedCapability=input.mode==="CONTINUE"
      ?(await tx.agentSession.findFirst({where:{conversationId:input.conversationId,providerId:input.selectedProviderId,capability:{not:null}},orderBy:{createdAt:"desc"},select:{capability:true}}))?.capability as ExecutionCapability|null|undefined
      :undefined;
    const capability=resolveExecutionCapability(input.selectedProviderId,input.mode,continuedCapability);
    if(!capability)throw new Error(`${input.selectedProviderId} does not support ${input.mode} execution.`);

    // A per-execution snapshot of the CLI version active right now, so a historical
    // execution keeps showing the version that actually ran it even after the CLI is
    // later upgraded (ProviderHealth.version is live/mutable and would not preserve this).
    const providerHealth=await tx.providerHealth.findUnique({where:{providerId:input.selectedProviderId},select:{version:true}});

    const purpose=agentSessionPurpose(input.mode);
    const agentSession=await tx.agentSession.create({data:{projectId:input.projectId,taskId,providerId:input.selectedProviderId,state:"QUEUED",purpose,readOnly:purpose!=="IMPLEMENTATION",capability,requestedModel:effectiveModel,reasoningEffort:effectiveReasoningEffort,modelSource,providerVersion:providerHealth?.version??null,providerSessionId:providerSession.id,conversationId:input.conversationId}});

    const userMessage=await tx.conversationMessage.create({data:{conversationId:input.conversationId,role:"USER",mode:input.mode,content:input.content,status:"COMPLETED",idempotencyKey:input.idempotencyKey,...(input.taskId?{taskId:input.taskId}:{})}});

    await tx.agentSession.update({where:{id:agentSession.id},data:{userMessageId:userMessage.id}});

    const routingDecision=await tx.routingDecision.create({data:{conversationId:input.conversationId,userMessageId:userMessage.id,selectedProviderId:input.selectedProviderId,requestedModel:input.requestedModel??null,selectedModel:effectiveModel,reason:input.reason,providerHealthSnapshot:input.providerHealthSnapshot as Prisma.InputJsonValue,...(input.requestedProviderId?{requestedProviderId:input.requestedProviderId}:{})}});

    const previousProviderId=input.previousAssistantMessage?.providerId??null;
    const providerChanged=Boolean(previousProviderId&&previousProviderId!==input.selectedProviderId);
    // A model switch within the *same* provider (e.g. Sonnet -> Opus) is exactly as
    // significant as a provider switch for handoff purposes: it is why providerSession
    // reuse was refused above, and it deserves the same recorded trail.
    const modelChangedWithinProvider=!providerChanged&&Boolean(latestSessionForProvider)&&latestSessionForProvider!.resolvedModel!==effectiveModel;
    let handoffCapsule:Awaited<ReturnType<typeof createHandoffCapsuleWithClient>>|null=null;
    if(providerChanged||modelChangedWithinProvider){
      const previousProviderLatestSession=providerChanged
        ?await tx.providerSession.findFirst({where:{conversationId:input.conversationId,providerId:previousProviderId!},orderBy:{startedAt:"desc"}})
        :null;
      handoffCapsule=await createHandoffCapsuleWithClient(tx,{
        conversationId:input.conversationId,
        fromProviderId:previousProviderId??input.selectedProviderId,
        toProviderId:input.selectedProviderId,
        fromModel:providerChanged?previousProviderLatestSession?.resolvedModel??null:latestSessionForProvider!.resolvedModel,
        toModel:effectiveModel,
        objective:input.content.slice(0,2_000),
        relevantDecisions:{},
        filesChanged:{},
        gitBaseline:{},
        gitDiffSummary:"",
        tests:{},
        unresolvedIssues:{},
        acceptedFindings:{},
        sourceMessageRange:{fromMessageId:input.previousAssistantMessage!.id,toMessageId:userMessage.id}
      });
    }

    const jobPayload={
      sessionId:agentSession.id,
      taskId,
      conversationId:input.conversationId,
      messageId:userMessage.id,
      providerId:input.selectedProviderId,
      routingDecisionId:routingDecision.id,
      providerSessionId:providerSession.id,
      ...(handoffCapsule?{handoffCapsuleId:handoffCapsule.id}:{})
    };
    const outboxEvent=await createOutboxEventWithClient(tx,{topic:"conversation-message",jobId:agentSession.id,payload:jobPayload});

    return{duplicate:false as const,userMessage,routingDecision,providerSession,handoffCapsule,agentSession,taskId,outboxEvent};
  });
}

export async function getProviderHealthDisplay(providerIds:string[]){const rows=await prisma.providerHealth.findMany({where:{providerId:{in:providerIds}}});const byId=new Map(rows.map(row=>[row.providerId,row]));const display:Record<string,{installed:boolean;authentication:string;available:boolean;version:string|null}>={};for(const providerId of providerIds){const row=byId.get(providerId);display[providerId]=row?{installed:row.installed,authentication:row.authentication,available:row.available,version:row.version}:{installed:false,authentication:"UNKNOWN",available:false,version:null};}return display;}

export const getActiveConversationExecution=(conversationId:string)=>prisma.agentSession.findFirst({where:{conversationId,state:{in:["QUEUED","STARTING","RUNNING","WAITING_FOR_APPROVAL"]}},orderBy:{createdAt:"desc"},select:{id:true,state:true,providerId:true}});

export async function getConversationExecution(executionId:string){
  const agentSession=await prisma.agentSession.findUnique({where:{id:executionId}});
  if(!agentSession)return null;
  const[events,assistantMessage,providerSession]=await Promise.all([
    prisma.agentEvent.findMany({where:{sessionId:executionId},orderBy:{id:"asc"}}),
    prisma.conversationMessage.findFirst({where:{agentSessionId:executionId}}),
    agentSession.providerSessionId?prisma.providerSession.findUnique({where:{id:agentSession.providerSessionId}}):Promise.resolve(null)
  ]);
  return{agentSession,events,assistantMessage,providerSession};
}

export async function retryConversationExecution(input:{executionId:string;providerId:string;idempotencyKey:string}){
  return prisma.$transaction(async tx=>{
    const original=await tx.agentSession.findUniqueOrThrow({where:{id:input.executionId},include:{userMessage:true}});
    if(!original.userMessage||!original.conversationId||!["FAILED","TIMED_OUT","CANCELLED"].includes(original.state))throw new Error("Execution is not retryable.");
    if(!getProviderModeCapability(input.providerId,original.userMessage.mode))throw new Error(`${input.providerId} does not support ${original.userMessage.mode} execution.`);
    const active=await tx.agentSession.findFirst({where:{conversationId:original.conversationId,userMessageId:original.userMessageId,providerId:input.providerId,state:{in:["QUEUED","STARTING","RUNNING"]}}});if(active)return active;
    // A same-provider retry preserves the original model exactly (treated as the explicit
    // selection, taking priority over project/application defaults, mirroring "resume
    // preserves the original model"); a provider-switching retry re-resolves through the
    // normal priority chain instead, since the original model may not even belong to the
    // new provider.
    const{model:effectiveModel,reasoningEffort:effectiveReasoningEffort,modelSource}=await resolveModelSelection(tx,{
      providerId:input.providerId,
      projectId:original.projectId,
      explicitModel:input.providerId===original.providerId?original.requestedModel:undefined,
      explicitReasoningEffort:input.providerId===original.providerId?original.reasoningEffort:undefined
    });
    const latestSessionForProvider=await tx.providerSession.findFirst({where:{conversationId:original.conversationId,providerId:input.providerId},orderBy:{startedAt:"desc"}});
    const existingSession=latestSessionForProvider&&latestSessionForProvider.status==="RUNNING"&&latestSessionForProvider.resolvedModel===effectiveModel?latestSessionForProvider:null;
    if(!existingSession&&latestSessionForProvider?.status==="RUNNING"){
      await tx.providerSession.update({where:{id:latestSessionForProvider.id},data:{status:"COMPLETED",endedAt:new Date()}});
    }
    const ps=existingSession??await tx.providerSession.create({data:{conversationId:original.conversationId,providerId:input.providerId,status:"RUNNING",startedAt:new Date(),resolvedModel:effectiveModel,...(effectiveReasoningEffort?{reasoningEffort:effectiveReasoningEffort}:{})}});
    // Re-resolve rather than blindly copying original.capability: a retry can switch
    // provider (input.providerId vs original.providerId), so CONTINUE inheritance must
    // look at the target provider's own most recent execution, not the original's.
    const continuedCapability=original.userMessage.mode==="CONTINUE"
      ?(await tx.agentSession.findFirst({where:{conversationId:original.conversationId,providerId:input.providerId,capability:{not:null}},orderBy:{createdAt:"desc"},select:{capability:true}}))?.capability as ExecutionCapability|null|undefined
      :undefined;
    const capability=resolveExecutionCapability(input.providerId,original.userMessage.mode,continuedCapability);
    if(!capability)throw new Error(`${input.providerId} does not support ${original.userMessage.mode} execution.`);
    const providerHealth=await tx.providerHealth.findUnique({where:{providerId:input.providerId},select:{version:true}});
    const retry=await tx.agentSession.create({data:{projectId:original.projectId,taskId:original.taskId,providerId:input.providerId,state:"QUEUED",purpose:original.purpose,readOnly:original.readOnly,capability,requestedModel:effectiveModel,reasoningEffort:effectiveReasoningEffort,modelSource,providerVersion:providerHealth?.version??null,providerSessionId:ps.id,conversationId:original.conversationId,userMessageId:original.userMessageId}});
    const routing=await tx.routingDecision.create({data:{conversationId:original.conversationId,userMessageId:original.userMessageId,requestedProviderId:input.providerId,selectedProviderId:input.providerId,requestedModel:effectiveModel,selectedModel:effectiveModel,reason:"User-requested retry",providerHealthSnapshot:{retryOf:original.id,idempotencyKey:input.idempotencyKey}}});
    const prior=await tx.conversationMessage.findFirst({where:{conversationId:original.conversationId,role:"ASSISTANT"},orderBy:{createdAt:"desc"}});
    const priorProviderChanged=Boolean(prior?.providerId&&prior.providerId!==input.providerId);
    const modelChangedWithinProvider=!priorProviderChanged&&Boolean(prior?.providerId)&&latestSessionForProvider?.resolvedModel!==effectiveModel;
    const priorProviderLatestSession=priorProviderChanged
      ?await tx.providerSession.findFirst({where:{conversationId:original.conversationId,providerId:prior!.providerId!},orderBy:{startedAt:"desc"}})
      :null;
    const handoff=prior?.providerId&&(priorProviderChanged||modelChangedWithinProvider)?await createHandoffCapsuleWithClient(tx,{conversationId:original.conversationId,fromProviderId:prior.providerId,toProviderId:input.providerId,fromModel:priorProviderChanged?priorProviderLatestSession?.resolvedModel??null:latestSessionForProvider!.resolvedModel,toModel:effectiveModel,objective:original.userMessage.content.slice(0,2000),relevantDecisions:{},filesChanged:{},gitBaseline:{},gitDiffSummary:"",tests:{},unresolvedIssues:{},acceptedFindings:{},sourceMessageRange:{fromMessageId:prior.id,toMessageId:original.userMessageId!}}):null;
    await createOutboxEventWithClient(tx,{topic:"conversation-message",jobId:retry.id,payload:{sessionId:retry.id,taskId:retry.taskId,conversationId:original.conversationId,messageId:original.userMessageId!,providerId:input.providerId,routingDecisionId:routing.id,providerSessionId:ps.id,...(handoff?{handoffCapsuleId:handoff.id}:{})}});
    return retry;
  });
}
