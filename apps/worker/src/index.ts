import { Worker, type Job } from "bullmq";
import { Prisma, prisma } from "@project-relay/database";
import { inspectGit, runCommand } from "@project-relay/execution";
import { appendMemoryUpdate } from "@project-relay/project-memory";
import { CodexCliProvider } from "@project-relay/providers";
import { commandSpecSchema, sessionJobSchema, type CommandSpec, type SessionJob, type TaskCapsuleContent } from "@project-relay/shared";

const redisUrl=new URL(process.env.REDIS_URL??"redis://localhost:6379");
const connection={host:redisUrl.hostname,port:Number(redisUrl.port||6379),...(redisUrl.password?{password:decodeURIComponent(redisUrl.password)}:{})};
const provider=new CodexCliProvider();
const terminalStates=["SUCCEEDED","FAILED","CANCELLED","TIMED_OUT"] as const;

async function event(sessionId:string,type:string,message:string,stream?:string){await prisma.agentEvent.create({data:{sessionId,type,message,...(stream?{stream}:{})}});}
function matchingCriterion(criteria:Array<{id:string;description:string}>,kind:string){const words:Record<string,string[]>={TYPECHECK:["type","typescript","compile"],LINT:["lint","eslint"],UNIT_TEST:["test","unit"],INTEGRATION_TEST:["integration","test"],BUILD:["build","production"],MIGRATION:["migration","database","schema"],GIT_STATUS:["git","file","change","diff"],GIT_DIFF:["git","file","change","diff"]};return criteria.find(c=>(words[kind]??[]).some(word=>c.description.toLowerCase().includes(word)))?.id;}

async function captureEvidence(input:{sessionId:string;taskId:string;workspace:string;commands:CommandSpec[];criteria:Array<{id:string;description:string}>}){
  const git=await inspectGit(input.workspace);
  for(const [kind,output] of [["GIT_STATUS",git.status],["GIT_DIFF",git.status]] as const){await prisma.evidence.create({data:{taskId:input.taskId,sessionId:input.sessionId,criterionId:matchingCriterion(input.criteria,kind)??null,kind,successful:true,output,metadata:{branch:git.branch,commit:git.commit,dirty:git.dirty}}});}
  let failed=false;
  for(const command of input.commands.filter(c=>c.category==="safe")){
    await event(input.sessionId,"command",`Starting ${command.label}`);
    const result=await runCommand({workspace:input.workspace,command,onEvent:async e=>event(input.sessionId,e.stream,e.text,e.stream),maxOutputBytes:Number(process.env.PROJECT_RELAY_MAX_OUTPUT_BYTES??65536)});
    const successful=result.exitCode===0&&!result.timedOut&&!result.cancelled;failed ||= !successful;
    await prisma.evidence.create({data:{taskId:input.taskId,sessionId:input.sessionId,criterionId:matchingCriterion(input.criteria,command.evidenceKind)??null,kind:command.evidenceKind,commandId:command.id,startedAt:result.startedAt,endedAt:result.endedAt,exitCode:result.exitCode,output:result.output,successful}});
    await event(input.sessionId,"command",`${command.label} ${successful?"passed":"failed"} (exit ${String(result.exitCode)})`);
  }
  const criteria=await prisma.acceptanceCriterion.findMany({where:{taskId:input.taskId},include:{evidence:{where:{successful:true}}}});
  await prisma.acceptanceCriterion.updateMany({where:{taskId:input.taskId,id:{in:criteria.filter(c=>c.evidence.length>0).map(c=>c.id)}},data:{passed:true}});
  const allSupported=criteria.length>0&&criteria.every(c=>c.evidence.length>0);
  await prisma.task.update({where:{id:input.taskId},data:{status:failed?"TEST_FAILED":allSupported?"READY_FOR_REVIEW":"CODE_COMPLETE"}});
}

async function processSession(job:Job<SessionJob>){const parsed=sessionJobSchema.parse(job.data);const session=await prisma.agentSession.findUnique({where:{id:parsed.sessionId},include:{project:true,task:{include:{criteria:true}},}});const capsule=await prisma.taskCapsule.findUnique({where:{id:parsed.capsuleId}});if(!session||!capsule)throw new Error("Queued session references missing state.");
  await prisma.agentSession.update({where:{id:session.id},data:{state:"STARTING",startedAt:new Date()}});await event(session.id,"state","Checking Codex CLI availability.");const status=await provider.checkAvailability();if(!status.available)throw new Error(status.setup??"Codex CLI unavailable.");
  const providerSession=await provider.createSession({workspace:session.project.repositoryPath,taskId:session.taskId});await prisma.agentSession.update({where:{id:session.id},data:{state:"RUNNING",externalId:providerSession.id}});await event(session.id,"state",`Running ${status.version??"Codex CLI"}.`);
  const consume=(async()=>{for await(const item of provider.streamEvents(providerSession.id)){await event(session.id,item.type,item.message,item.type==="stdout"||item.type==="stderr"?item.type:undefined);}})();
  try{await provider.sendTask(providerSession,capsule.content as TaskCapsuleContent);await provider.cancelSession(providerSession.id);await consume;const commands=(session.project.allowedCommands as Prisma.JsonArray).map(item=>commandSpecSchema.parse(item));await captureEvidence({sessionId:session.id,taskId:session.taskId,workspace:session.project.repositoryPath,commands,criteria:session.task.criteria});const usage=await provider.getUsage(providerSession.id);await prisma.agentSession.update({where:{id:session.id},data:{state:"SUCCEEDED",endedAt:new Date(),exitCode:0,usage}});await event(session.id,"state","Session completed; evidence captured.");await appendMemoryUpdate({workspace:session.project.repositoryPath,file:"CURRENT_STATE.md",changed:`Agent session ${session.id} completed.`,reason:"Codex provider run completed and evidence was captured.",taskId:session.taskId,agent:"codex",evidence:`session:${session.id}`,confidence:"MEDIUM"});}catch(error){await provider.cancelSession(providerSession.id);const message=error instanceof Error?error.message:"Worker failure";await prisma.agentSession.update({where:{id:session.id},data:{state:"FAILED",endedAt:new Date(),error:message}});await prisma.task.update({where:{id:session.taskId},data:{status:"BLOCKED"}});await event(session.id,"state",message);throw error;}}

const worker=new Worker<SessionJob>("agent-sessions",processSession,{connection,concurrency:1});
worker.on("failed",async(job,error)=>{if(job){const state=await prisma.agentSession.findUnique({where:{id:job.data.sessionId},select:{state:true}});if(state&&!terminalStates.includes(state.state as typeof terminalStates[number]))await prisma.agentSession.update({where:{id:job.data.sessionId},data:{state:"FAILED",endedAt:new Date(),error:error.message}});}});
console.log("ProjectRelay worker listening for agent-sessions jobs.");
async function shutdown(){await worker.close();await prisma.$disconnect();process.exit(0);}process.on("SIGINT",()=>void shutdown());process.on("SIGTERM",()=>void shutdown());
