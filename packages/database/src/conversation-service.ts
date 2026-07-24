import { createHash } from "node:crypto";
import { getProviderModeCapability, resolveExecutionCapability, type ExecutionCapability } from "@project-relay/shared";
import { Prisma, prisma } from "./index.js";
import { createOutboxEventWithClient } from "./outbox-service.js";
const HANDOFF_MAX_BYTES=32_768;
function canonical(value:unknown):string{if(Array.isArray(value))return`[${value.map(canonical).join(",")}]`;if(value&&typeof value==="object")return`{${Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>`${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;return JSON.stringify(value);}
export const handoffChecksum=(value:unknown)=>createHash("sha256").update(canonical(value)).digest("hex");
type HandoffCapsuleInput={conversationId:string;fromProviderId:string;toProviderId:string;objective:string;relevantDecisions:object;filesChanged:object;gitBaseline:object;gitDiffSummary:string;tests:object;unresolvedIssues:object;acceptedFindings:object;sourceMessageRange:object};

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

export type QueueConversationMessageInput={
  conversationId:string;
  projectId:string;
  content:string;
  mode:ConversationMode;
  taskId?:string;
  selectedProviderId:string;
  requestedProviderId?:string;
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

    const existingSession=await tx.providerSession.findFirst({where:{conversationId:input.conversationId,providerId:input.selectedProviderId,status:"RUNNING"},orderBy:{startedAt:"desc"}});
    const providerSession=existingSession??await tx.providerSession.create({data:{conversationId:input.conversationId,providerId:input.selectedProviderId,status:"RUNNING",startedAt:new Date()}});

    const taskId=input.taskId??(await tx.task.create({data:{projectId:input.projectId,title:input.content.slice(0,160)||"Conversation message",userRequest:input.content,objective:input.content.slice(0,2_000),relevantFiles:[],constraints:[],prohibitedChanges:[],assignedProvider:input.selectedProviderId}})).id;

    // CONTINUE inheritance (Claude only - see resolveExecutionCapability) needs the
    // capability of the most recent prior execution for this exact provider in this
    // conversation, never a browser-supplied value.
    const continuedCapability=input.mode==="CONTINUE"
      ?(await tx.agentSession.findFirst({where:{conversationId:input.conversationId,providerId:input.selectedProviderId,capability:{not:null}},orderBy:{createdAt:"desc"},select:{capability:true}}))?.capability as ExecutionCapability|null|undefined
      :undefined;
    const capability=resolveExecutionCapability(input.selectedProviderId,input.mode,continuedCapability);
    if(!capability)throw new Error(`${input.selectedProviderId} does not support ${input.mode} execution.`);

    const purpose=agentSessionPurpose(input.mode);
    const agentSession=await tx.agentSession.create({data:{projectId:input.projectId,taskId,providerId:input.selectedProviderId,state:"QUEUED",purpose,readOnly:purpose!=="IMPLEMENTATION",capability,providerSessionId:providerSession.id,conversationId:input.conversationId}});

    const userMessage=await tx.conversationMessage.create({data:{conversationId:input.conversationId,role:"USER",mode:input.mode,content:input.content,status:"COMPLETED",idempotencyKey:input.idempotencyKey,...(input.taskId?{taskId:input.taskId}:{})}});

    await tx.agentSession.update({where:{id:agentSession.id},data:{userMessageId:userMessage.id}});

    const routingDecision=await tx.routingDecision.create({data:{conversationId:input.conversationId,userMessageId:userMessage.id,selectedProviderId:input.selectedProviderId,reason:input.reason,providerHealthSnapshot:input.providerHealthSnapshot as Prisma.InputJsonValue,...(input.requestedProviderId?{requestedProviderId:input.requestedProviderId}:{})}});

    const previousProviderId=input.previousAssistantMessage?.providerId??null;
    let handoffCapsule:Awaited<ReturnType<typeof createHandoffCapsuleWithClient>>|null=null;
    if(previousProviderId&&previousProviderId!==input.selectedProviderId){
      handoffCapsule=await createHandoffCapsuleWithClient(tx,{
        conversationId:input.conversationId,
        fromProviderId:previousProviderId,
        toProviderId:input.selectedProviderId,
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
    const ps=await tx.providerSession.findFirst({where:{conversationId:original.conversationId,providerId:input.providerId,status:"RUNNING"},orderBy:{startedAt:"desc"}})??await tx.providerSession.create({data:{conversationId:original.conversationId,providerId:input.providerId,status:"RUNNING",startedAt:new Date()}});
    // Re-resolve rather than blindly copying original.capability: a retry can switch
    // provider (input.providerId vs original.providerId), so CONTINUE inheritance must
    // look at the target provider's own most recent execution, not the original's.
    const continuedCapability=original.userMessage.mode==="CONTINUE"
      ?(await tx.agentSession.findFirst({where:{conversationId:original.conversationId,providerId:input.providerId,capability:{not:null}},orderBy:{createdAt:"desc"},select:{capability:true}}))?.capability as ExecutionCapability|null|undefined
      :undefined;
    const capability=resolveExecutionCapability(input.providerId,original.userMessage.mode,continuedCapability);
    if(!capability)throw new Error(`${input.providerId} does not support ${original.userMessage.mode} execution.`);
    const retry=await tx.agentSession.create({data:{projectId:original.projectId,taskId:original.taskId,providerId:input.providerId,state:"QUEUED",purpose:original.purpose,readOnly:original.readOnly,capability,providerSessionId:ps.id,conversationId:original.conversationId,userMessageId:original.userMessageId}});
    const routing=await tx.routingDecision.create({data:{conversationId:original.conversationId,userMessageId:original.userMessageId,requestedProviderId:input.providerId,selectedProviderId:input.providerId,reason:"User-requested retry",providerHealthSnapshot:{retryOf:original.id,idempotencyKey:input.idempotencyKey}}});
    const prior=await tx.conversationMessage.findFirst({where:{conversationId:original.conversationId,role:"ASSISTANT"},orderBy:{createdAt:"desc"}});
    const handoff=prior?.providerId&&prior.providerId!==input.providerId?await createHandoffCapsuleWithClient(tx,{conversationId:original.conversationId,fromProviderId:prior.providerId,toProviderId:input.providerId,objective:original.userMessage.content.slice(0,2000),relevantDecisions:{},filesChanged:{},gitBaseline:{},gitDiffSummary:"",tests:{},unresolvedIssues:{},acceptedFindings:{},sourceMessageRange:{fromMessageId:prior.id,toMessageId:original.userMessageId!}}):null;
    await createOutboxEventWithClient(tx,{topic:"conversation-message",jobId:retry.id,payload:{sessionId:retry.id,taskId:retry.taskId,conversationId:original.conversationId,messageId:original.userMessageId!,providerId:input.providerId,routingDecisionId:routing.id,providerSessionId:ps.id,...(handoff?{handoffCapsuleId:handoff.id}:{})}});
    return retry;
  });
}
