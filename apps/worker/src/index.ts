import { createHash } from "node:crypto";
import { Queue, Worker, type Job } from "bullmq";
import { dispatchPendingOutboxEvents, Prisma, prisma, recoverStuckOutboxEvents } from "@project-relay/database";
import { inspectGit, runCommand } from "@project-relay/execution";
import { appendMemoryUpdate } from "@project-relay/project-memory";
import { providerRegistry, type ExecutionCapability, type ProviderRole } from "@project-relay/providers";
import { assertLoopbackHost, commandSpecSchema, findLockedDecisionConflicts, sessionJobSchema, type CommandSpec, type ConversationMessageJob, type SessionJob, type TaskCapsuleContent } from "@project-relay/shared";
import { pollCancellation } from "./cancellation.js";
import { processConversationMessage } from "./conversation-worker.js";
import { parseReviewFindings } from "./review-findings.js";
import { providerHealthMonitor, type ProviderHealthMode } from "./provider-health.js";
import { modelHealthMonitor } from "./model-health.js";
import { claimAgentSession, DEFAULT_LEASE_MS, newWorkerId, reapExpiredAgentSessions, releasedLeaseFields, startHeartbeat } from "./worker-lease.js";

const WORKER_ID = newWorkerId();
const REAP_INTERVAL_MS = Number(process.env.PROJECT_RELAY_WORKER_REAP_INTERVAL_MS ?? 30_000);

const databaseUrl=new URL(process.env.DATABASE_URL??"postgresql://localhost:5432/postgres");
const redisUrl=new URL(process.env.REDIS_URL??"redis://localhost:6379");
assertLoopbackHost(databaseUrl.hostname,"DATABASE_URL");
assertLoopbackHost(redisUrl.hostname,"REDIS_URL");
const connection={host:redisUrl.hostname,port:Number(redisUrl.port||6379),...(redisUrl.password?{password:decodeURIComponent(redisUrl.password)}:{})};
const terminalStates=["SUCCEEDED","FAILED","CANCELLED","TIMED_OUT"] as const;
if(process.env.PROJECT_RELAY_WORKER_CONTAINER==="true")throw new Error("Provider worker must run natively under the signed-in Windows user, not in Docker.");
async function event(sessionId:string,type:string,message:string,stream?:string){await prisma.agentEvent.create({data:{sessionId,type,message,...(stream?{stream}:{})}});}

function evidenceLinks(criterion:{evidenceKinds:unknown;commandIds:unknown},kind:string,commandId?:string){const kinds=criterion.evidenceKinds as string[];const commands=criterion.commandIds as string[];return kinds.includes(kind)&&(!commands.length||Boolean(commandId&&commands.includes(commandId)));}
async function captureEvidence(input:{sessionId:string;taskId:string;workspace:string;commands:CommandSpec[];criteria:Array<{id:string;description:string;evidenceKinds:unknown;commandIds:unknown}>;decisions:Array<{id:string;forbiddenPaths:unknown;requiredPatterns:unknown}>}){
  const git=await inspectGit(input.workspace);let failed=false;
  for(const [kind,output] of [["GIT_STATUS",git.status],["GIT_DIFF",git.diff],["CHANGED_FILES",git.status]] as const){for(const criterion of input.criteria.filter(c=>evidenceLinks(c,kind))){await prisma.evidence.create({data:{taskId:input.taskId,sessionId:input.sessionId,criterionId:criterion.id,kind,successful:true,output,metadata:{branch:git.branch,commit:git.commit,dirty:git.dirty}}});}}
  const changed=git.status.split("\n").filter(Boolean).map(line=>line.slice(3).trim());const conflicts=findLockedDecisionConflicts(input.decisions.map(d=>({id:d.id,forbiddenPaths:d.forbiddenPaths as string[],requiredPatterns:d.requiredPatterns as string[]})),changed,git.diff);
  if(conflicts.length){failed=true;await event(input.sessionId,"policy",`Locked decision conflict: ${conflicts.join("; ")}`);await prisma.auditEvent.create({data:{projectId:(await prisma.agentSession.findUniqueOrThrow({where:{id:input.sessionId}})).projectId,actor:"worker",action:"LOCKED_DECISION_CONFLICT",details:{taskId:input.taskId,conflicts}}});}
  for(const command of input.commands){
    await event(input.sessionId,"command",`Starting ${command.label}`);const controller=new AbortController();
    const cancelMonitor=pollCancellation({isCancelled:async()=>((await prisma.agentSession.findUnique({where:{id:input.sessionId},select:{state:true}}))?.state==="CANCELLED"),abort:()=>controller.abort(),signal:controller.signal});
    const approval=command.category==="destructive"?await prisma.approval.findFirst({where:{projectId:(await prisma.agentSession.findUniqueOrThrow({where:{id:input.sessionId}})).projectId,action:`command:${command.id}`,status:"APPROVED"}}):null;const result=await runCommand({workspace:input.workspace,command,signal:controller.signal,onEvent:async e=>event(input.sessionId,e.stream,e.text,e.stream),maxOutputBytes:Number(process.env.PROJECT_RELAY_MAX_OUTPUT_BYTES??65536),approved:command.category==="safe"||Boolean(approval)});controller.abort();await cancelMonitor;
    const successful=result.exitCode===0&&!result.timedOut&&!result.cancelled;if(!successful)failed=true;
    for(const criterion of input.criteria.filter(c=>evidenceLinks(c,command.evidenceKind,command.id))){await prisma.evidence.create({data:{taskId:input.taskId,sessionId:input.sessionId,criterionId:criterion.id,kind:command.evidenceKind,commandId:command.id,startedAt:result.startedAt,endedAt:result.endedAt,exitCode:result.exitCode,output:result.output,successful}});}
    await event(input.sessionId,"command",`${command.label} ${successful?"passed":"failed"} (exit ${String(result.exitCode)})`);
  }
  const criteria=await prisma.acceptanceCriterion.findMany({where:{taskId:input.taskId},include:{evidence:{where:{successful:true}}}});await prisma.acceptanceCriterion.updateMany({where:{taskId:input.taskId,id:{in:criteria.filter(c=>c.evidence.length>0).map(c=>c.id)}},data:{passed:true}});const allSupported=criteria.length>0&&criteria.every(c=>c.evidence.length>0);await prisma.task.update({where:{id:input.taskId},data:{status:failed?"TEST_FAILED":allSupported?"READY_FOR_REVIEW":"CODE_COMPLETE"}});
}

function hashGit(git:{commit:string|null;status:string;diff:string}){return createHash("sha256").update(`${git.commit}\n${git.status}\n${git.diff}`).digest("hex");}
async function saveReviewFindings(taskId:string,sessionId:string,output:string,stale:boolean){for(const parsed of parseReviewFindings(output))await prisma.reviewFinding.create({data:{taskId,sessionId,...parsed,stale}});}

async function processSession(job:Job<SessionJob>){const parsed=sessionJobSchema.parse(job.data);
  const claimed=await claimAgentSession(parsed.sessionId,WORKER_ID,DEFAULT_LEASE_MS);if(!claimed)return;
  const stopHeartbeat=startHeartbeat(parsed.sessionId,WORKER_ID,DEFAULT_LEASE_MS);
  try{await processClaimedSession(parsed);}finally{stopHeartbeat();}}

async function processClaimedSession(parsed:SessionJob){const session=await prisma.agentSession.findUnique({where:{id:parsed.sessionId},include:{project:{include:{decisions:{where:{status:"ACCEPTED",locked:true}}}},task:{include:{criteria:true}}}});const capsule=await prisma.taskCapsule.findUnique({where:{id:parsed.capsuleId}});if(!session||!capsule)throw new Error("Queued session references missing state.");const provider=providerRegistry.get(session.providerId);const role=(session.purpose==="IMPLEMENTATION"?"IMPLEMENTER":session.purpose==="VERIFICATION"?"VERIFIER":"REVIEWER")as ProviderRole;const capability:ExecutionCapability=session.purpose==="IMPLEMENTATION"&&session.providerId==="codex-cli"?"WORKSPACE_WRITE":"READ_ONLY";
  await event(session.id,"state",`Checking ${provider.name} availability.`);const status=await provider.probeAuthentication();if(!status.available)throw new Error(`${provider.name} is ${status.authentication.toLowerCase()}. ${provider.setupInstructions}`);
  const providerSession=await provider.createSession({workspace:session.project.repositoryPath,taskId:session.taskId,role,capability,...(session.externalId?{resumeExternalId:session.externalId}:{})});await prisma.agentSession.update({where:{id:session.id},data:{state:"RUNNING",externalId:providerSession.id}});await event(session.id,"state",`Running ${status.version??provider.name}.`);let providerOutput="";
  const consume=(async()=>{for await(const item of provider.streamEvents(providerSession.id)){providerOutput+=item.message;await event(session.id,item.type,item.message,item.type==="stdout"||item.type==="stderr"?item.type:undefined);}})();const controller=new AbortController();const monitor=pollCancellation({isCancelled:async()=>((await prisma.agentSession.findUnique({where:{id:session.id},select:{state:true}}))?.state==="CANCELLED"),abort:()=>{controller.abort();void provider.cancelSession(providerSession.id);},signal:controller.signal});
  try{if(session.externalId)await provider.resumeSession(providerSession,capsule.content as TaskCapsuleContent,controller.signal);else await provider.startSession(providerSession,capsule.content as TaskCapsuleContent,controller.signal);await consume;controller.abort();await monitor;const persisted=await prisma.agentSession.findUnique({where:{id:session.id},select:{state:true}});if(persisted?.state==="CANCELLED"){await event(session.id,"state","Session cancelled.");return;}
    if(session.purpose==="IMPLEMENTATION"){const commands=(session.project.allowedCommands as Prisma.JsonArray).map(item=>commandSpecSchema.parse(item));await captureEvidence({sessionId:session.id,taskId:session.taskId,workspace:session.project.repositoryPath,commands,criteria:session.task.criteria,decisions:session.project.decisions});}else{const current=await inspectGit(session.project.repositoryPath);const stale=hashGit(current)!==session.baselineDiffHash;await saveReviewFindings(session.taskId,session.id,providerOutput,stale);if(stale)await event(session.id,"state","Review is stale because the workspace changed during review.");}
    const usage=await provider.getUsage(providerSession.id);await providerHealthMonitor.recordTaskResponse(session.providerId,true);await prisma.agentSession.update({where:{id:session.id},data:{state:"SUCCEEDED",endedAt:new Date(),exitCode:0,usage,externalId:providerSession.externalId??providerSession.id,...releasedLeaseFields}});await event(session.id,"state","Session completed.");await appendMemoryUpdate({workspace:session.project.repositoryPath,file:"CURRENT_STATE.md",changed:`Agent session ${session.id} completed.`,reason:`${provider.name} ${session.purpose.toLowerCase()} run completed.`,taskId:session.taskId,agent:provider.id,evidence:`session:${session.id}`,confidence:"MEDIUM"});
  }catch(error){controller.abort();await provider.cancelSession(providerSession.id);await monitor;const current=await prisma.agentSession.findUnique({where:{id:session.id},select:{state:true}});if(current?.state==="CANCELLED")return;const message=error instanceof Error?error.message:"Worker failure";await providerHealthMonitor.recordTaskResponse(session.providerId,false,message);await prisma.agentSession.update({where:{id:session.id},data:{state:"FAILED",endedAt:new Date(),error:message,...releasedLeaseFields}});await prisma.task.update({where:{id:session.taskId},data:{status:"BLOCKED"}});await event(session.id,"state",message);throw error;}}

// Reclaim only sessions whose lease has actually expired (or was never leased): a second
// worker booting up while another instance is still alive and heartbeating must not fail
// that instance's in-flight work. Safe to run repeatedly/concurrently - see reapExpiredAgentSessions.
await reapExpiredAgentSessions();
const reapTimer=setInterval(()=>void reapExpiredAgentSessions().catch(error=>console.error("Lease reap failed:",error)),REAP_INTERVAL_MS);reapTimer.unref();
const worker=new Worker<SessionJob>("agent-sessions",processSession,{connection,concurrency:1});
const conversationWorker=new Worker<ConversationMessageJob>("conversation-messages",job=>processConversationMessage(job,{workerId:WORKER_ID}),{connection,concurrency:1});
const providerHealthWorker=new Worker<{providerId:"codex-cli"|"claude-cli";mode:ProviderHealthMode}>("provider-health",async job=>providerHealthMonitor.probe(job.data.providerId,job.data.mode,true),{connection,concurrency:1});
const modelHealthWorker=new Worker<{providerId:"codex-cli"|"claude-cli";modelId:string;reasoningEffort?:string}>("model-health",async job=>modelHealthMonitor.probe(job.data.providerId,job.data.modelId,job.data.reasoningEffort,true),{connection,concurrency:1});
void providerHealthMonitor.startup();const refreshTimer=setInterval(()=>void providerHealthMonitor.refreshAll(),5*60_000);const authTimer=setInterval(()=>void providerHealthMonitor.authenticateAll(),15*60_000);refreshTimer.unref();authTimer.unref();
void modelHealthMonitor.startup();
worker.on("failed",async(job,error)=>{if(job){const state=await prisma.agentSession.findUnique({where:{id:job.data.sessionId},select:{state:true}});if(state&&!terminalStates.includes(state.state as typeof terminalStates[number]))await prisma.agentSession.update({where:{id:job.data.sessionId},data:{state:"FAILED",endedAt:new Date(),error:error.message,...releasedLeaseFields}});}});
conversationWorker.on("failed",async(job,error)=>{if(job){const state=await prisma.agentSession.findUnique({where:{id:job.data.sessionId},select:{state:true}});if(state&&!terminalStates.includes(state.state as typeof terminalStates[number]))await prisma.agentSession.update({where:{id:job.data.sessionId},data:{state:"FAILED",endedAt:new Date(),error:error.message,...releasedLeaseFields}});}});

const conversationMessageQueue=new Queue<ConversationMessageJob,void,"route">("conversation-messages",{connection});
async function publishOutboxEvent(event:{topic:string;jobId:string;payload:unknown}){
  if(event.topic==="conversation-message"){await conversationMessageQueue.add("route",event.payload as ConversationMessageJob,{jobId:event.jobId,removeOnComplete:100,removeOnFail:100});return;}
  throw new Error(`Unknown outbox topic '${event.topic}'.`);
}
await recoverStuckOutboxEvents();
const outboxTimer=setInterval(()=>void dispatchPendingOutboxEvents(publishOutboxEvent).catch(error=>console.error("Outbox dispatch failed:",error)),1_000);
outboxTimer.unref();

console.log("ProjectRelay worker listening for agent-sessions, conversation-messages, provider-health, and model-health jobs.");async function shutdown(){clearInterval(refreshTimer);clearInterval(authTimer);clearInterval(outboxTimer);clearInterval(reapTimer);await worker.close();await conversationWorker.close();await providerHealthWorker.close();await modelHealthWorker.close();await conversationMessageQueue.close();await prisma.$disconnect();process.exit(0);}process.on("SIGINT",()=>void shutdown());process.on("SIGTERM",()=>void shutdown());
