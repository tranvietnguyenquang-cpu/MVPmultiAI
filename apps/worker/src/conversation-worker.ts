import type { Job } from "bullmq";
import { prisma } from "@project-relay/database";
import { createTaskCapsule } from "@project-relay/context-engine";
import { redactSecrets } from "@project-relay/execution";
import type { ProviderRegistry, ProviderRole } from "@project-relay/providers";
import { providerRegistry as defaultRegistry } from "@project-relay/providers";
import { conversationMessageJobSchema, type ConversationMessageJob, type JsonValue, type TaskCapsuleContent } from "@project-relay/shared";

const MAX_ASSISTANT_MESSAGE_BYTES = 65_536;
const DEFAULT_TIMEOUT_MS = Number(process.env.PROJECT_RELAY_CONVERSATION_TIMEOUT_MS ?? 120_000);

async function event(sessionId: string, type: string, message: string, stream?: string) {
  await prisma.agentEvent.create({ data: { sessionId, type, message, ...(stream ? { stream } : {}) } });
}

type ConversationMode = "ASK" | "IMPLEMENT" | "REVIEW" | "CONTINUE" | "VERIFY";

function roleForMode(mode: ConversationMode): ProviderRole | undefined {
  if (mode === "IMPLEMENT") return "IMPLEMENTER";
  if (mode === "REVIEW") return "REVIEWER";
  if (mode === "VERIFY") return "VERIFIER";
  return undefined;
}

async function buildConversationCapsule(input: {
  workspace: string;
  task: { id: string; title: string; objective: string; relevantFiles: string[] };
  latestUserRequest: string;
  mode: ConversationMode;
  decisions: Array<{ id: string; title: string; decision: string; locked: boolean }>;
  handoff?: { fromProviderId: string; toProviderId: string; objective: string; unresolvedIssues: JsonValue; acceptedFindings: JsonValue };
}): Promise<TaskCapsuleContent> {
  const base = await createTaskCapsule({
    workspace: input.workspace,
    task: {
      id: input.task.id,
      title: input.task.title,
      objective: input.task.objective,
      userRequest: input.latestUserRequest,
      relevantFiles: input.task.relevantFiles,
      prohibitedChanges: []
    },
    decisions: input.decisions,
    criteria: [],
    evidence: []
  });
  return {
    ...base.content,
    conversationMode: input.mode,
    ...(input.handoff
      ? {
          handoff: {
            fromProviderId: input.handoff.fromProviderId,
            toProviderId: input.handoff.toProviderId,
            objective: input.handoff.objective.slice(0, 800),
            unresolvedIssues: input.handoff.unresolvedIssues,
            acceptedFindings: input.handoff.acceptedFindings
          }
        }
      : {})
  };
}

export type ConversationWorkerDeps = {
  registry?: Pick<ProviderRegistry, "get">;
  timeoutMs?: number;
};

export async function processConversationMessage(job: Job<ConversationMessageJob>, deps: ConversationWorkerDeps = {}): Promise<void> {
  const registry = deps.registry ?? defaultRegistry;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const data = conversationMessageJobSchema.parse(job.data);

  const claimed = await prisma.agentSession.updateMany({ where: { id: data.sessionId, state: "QUEUED" }, data: { state: "STARTING", startedAt: new Date() } });
  if (!claimed.count) return;

  const session = await prisma.agentSession.findUnique({
    where: { id: data.sessionId },
    include: { project: { include: { decisions: { where: { status: "ACCEPTED", locked: true } } } }, task: true }
  });
  if (!session) throw new Error("Queued conversation execution references a missing agent session.");

  const [conversation, userMessage, providerSession] = await Promise.all([
    prisma.conversation.findUniqueOrThrow({ where: { id: data.conversationId } }),
    prisma.conversationMessage.findUniqueOrThrow({ where: { id: data.messageId } }),
    prisma.providerSession.findUniqueOrThrow({ where: { id: data.providerSessionId } })
  ]);
  const handoffCapsule = data.handoffCapsuleId ? await prisma.handoffCapsule.findUnique({ where: { id: data.handoffCapsuleId } }) : null;

  await event(session.id, "state", "Queued conversation execution claimed.");
  const provider = registry.get(session.providerId);

  try {
    await event(session.id, "state", `Checking ${provider.name} availability.`);
    const status = await provider.probeAuthentication();
    if (!status.available) throw new Error(`${provider.name} is ${status.authentication.toLowerCase()}. ${provider.setupInstructions}`);

    const capsule = await buildConversationCapsule({
      workspace: session.project.repositoryPath,
      task: { id: session.task.id, title: session.task.title, objective: session.task.objective, relevantFiles: session.task.relevantFiles as string[] },
      latestUserRequest: userMessage.content,
      mode: userMessage.mode as ConversationMode,
      decisions: session.project.decisions,
      ...(handoffCapsule
        ? {
            handoff: {
              fromProviderId: handoffCapsule.fromProviderId,
              toProviderId: handoffCapsule.toProviderId,
              objective: handoffCapsule.objective,
              unresolvedIssues: handoffCapsule.unresolvedIssues as unknown as JsonValue,
              acceptedFindings: handoffCapsule.acceptedFindings as unknown as JsonValue
            }
          }
        : {})
    });
    await event(session.id, "state", "Prompt constructed from bounded conversation context.");

    await prisma.agentSession.update({ where: { id: session.id }, data: { state: "RUNNING" } });
    const role = roleForMode(userMessage.mode);
    const providerAgentSession = await provider.createSession({
      workspace: session.project.repositoryPath,
      taskId: session.taskId,
      ...(providerSession.externalSessionId ? { resumeExternalId: providerSession.externalSessionId } : {}),
      ...(role ? { role } : {})
    });
    await event(session.id, "state", `Running ${status.version ?? provider.name}.`);

    let providerOutput = "";
    const consume = (async () => {
      for await (const item of provider.streamEvents(providerAgentSession.id)) {
        providerOutput += item.message;
        await event(session.id, item.type, item.message, item.type === "stdout" || item.type === "stderr" ? item.type : undefined);
      }
    })();

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try {
      if (providerSession.externalSessionId) await provider.resumeSession(providerAgentSession, capsule, controller.signal);
      else await provider.startSession(providerAgentSession, capsule, controller.signal);
      await consume;
    } catch (runError) {
      if (timedOut) throw new Error(`${provider.name} execution timed out after ${timeoutMs}ms.`);
      throw runError;
    } finally {
      clearTimeout(timer);
    }
    if (timedOut) throw new Error(`${provider.name} execution timed out after ${timeoutMs}ms.`);

    const usage = await provider.getUsage(providerAgentSession.id);
    const redactedOutput = redactSecrets(providerOutput || "(no output)").slice(0, MAX_ASSISTANT_MESSAGE_BYTES);
    const externalSessionId = providerAgentSession.externalId ?? providerAgentSession.id;

    await prisma.$transaction(async tx => {
      const finalized = await tx.agentSession.updateMany({
        where: { id: session.id, state: "RUNNING" },
        data: { state: "SUCCEEDED", endedAt: new Date(), exitCode: 0, usage, externalId: externalSessionId }
      });
      if (!finalized.count) return;
      const assistantMessage = await tx.conversationMessage.create({
        data: {
          conversationId: conversation.id,
          role: "ASSISTANT",
          providerId: session.providerId,
          providerSessionId: providerSession.id,
          mode: userMessage.mode,
          content: redactedOutput,
          status: "COMPLETED",
          agentSessionId: session.id,
          ...(handoffCapsule ? { handoffCapsuleId: handoffCapsule.id } : {}),
          ...(session.taskId ? { taskId: session.taskId } : {})
        }
      });
      await tx.providerSession.update({
        where: { id: providerSession.id },
        data: { status: "RUNNING", lastMessageId: assistantMessage.id, externalSessionId }
      });
      await tx.conversation.update({ where: { id: conversation.id }, data: { activeProviderId: session.providerId } });
    });
    await event(session.id, "state", "Conversation execution completed.");
  } catch (error) {
    const message = redactSecrets(error instanceof Error ? error.message : "Worker failure").slice(0, MAX_ASSISTANT_MESSAGE_BYTES);
    await prisma.$transaction(async tx => {
      const finalized = await tx.agentSession.updateMany({ where: { id: session.id, state: { in: ["RUNNING", "STARTING"] } }, data: { state: "FAILED", endedAt: new Date(), error: message } });
      if (!finalized.count) return;
      await tx.conversationMessage.create({
        data: {
          conversationId: conversation.id,
          role: "ASSISTANT",
          providerId: session.providerId,
          providerSessionId: providerSession.id,
          mode: userMessage.mode,
          content: message,
          status: "FAILED",
          agentSessionId: session.id,
          ...(session.taskId ? { taskId: session.taskId } : {})
        }
      });
      await tx.providerSession.update({ where: { id: providerSession.id }, data: { status: "FAILED", endedAt: new Date() } });
    });
    await event(session.id, "state", message);
    throw error;
  }
}
