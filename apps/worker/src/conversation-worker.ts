import type { Job } from "bullmq";
import { prisma } from "@project-relay/database";
import { createTaskCapsule } from "@project-relay/context-engine";
import { redactSecrets } from "@project-relay/execution";
import type { AgentSession as ProviderAgentSession, CodingProvider, ProviderProcessLifecycle, ProviderRegistry, ProviderRole } from "@project-relay/providers";
import { providerRegistry as defaultRegistry, StaleProviderSessionError } from "@project-relay/providers";
import { conversationMessageJobSchema, getProviderModeCapability, type ConversationMessageJob, type JsonValue, type TaskCapsuleContent } from "@project-relay/shared";
import { claimAgentSession, DEFAULT_LEASE_MS, newWorkerId, releasedLeaseFields, startHeartbeat } from "./worker-lease.js";
import { captureOwnedProcess, terminateNewlySpawnedProcessTree, terminateOwnedProcessTree } from "./owned-process.js";

const MAX_ASSISTANT_MESSAGE_BYTES = 65_536;
const MIN_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 2_700_000;
type TimeoutPolicy = { inactivityMs: number; absoluteMs: number };
const DEFAULT_TIMEOUTS: Record<ConversationMode, TimeoutPolicy> = {
  ASK: { inactivityMs: 180_000, absoluteMs: 900_000 }, REVIEW: { inactivityMs: 300_000, absoluteMs: 1_200_000 },
  IMPLEMENT: { inactivityMs: 300_000, absoluteMs: 2_700_000 }, CONTINUE: { inactivityMs: 300_000, absoluteMs: 2_700_000 }, VERIFY: { inactivityMs: 300_000, absoluteMs: 1_800_000 }
};
/** Stable for the lifetime of this process; every claim/heartbeat from this worker shares one identity unless a caller injects its own (e.g. tests simulating multiple workers). */
const PROCESS_WORKER_ID = newWorkerId();

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
  /** Worker/test-only override; browser requests cannot provide timeout policy. */
  timeoutPolicy?: TimeoutPolicy;
  workerId?: string;
  leaseMs?: number;
};
export class ProviderExecutionTimeout extends Error { constructor(readonly code: "PROVIDER_INACTIVITY_TIMEOUT" | "PROVIDER_ABSOLUTE_TIMEOUT") { super(code === "PROVIDER_INACTIVITY_TIMEOUT" ? "The provider stopped producing progress." : "The execution exceeded its maximum allowed duration."); } }
export class ProviderExecutionCancelled extends Error {
  readonly code = "PROVIDER_CANCELLED";
  constructor() { super("Execution cancelled by user."); }
}
function bounded(value: string | undefined, fallback: number) { const n = Number(value); return Number.isFinite(n) ? Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, n)) : fallback; }
export function providerTimeoutPolicy(providerId: string, mode: ConversationMode, legacy?: number): TimeoutPolicy {
  // Dependency injection is test/worker-internal only; browser requests never reach this value.
  if (legacy) return { inactivityMs: legacy, absoluteMs: legacy };
  const defaults = DEFAULT_TIMEOUTS[mode]; const prefix = providerId === "codex-cli" ? "CODEX" : "CLAUDE";
  return { inactivityMs: bounded(process.env.PROJECT_RELAY_PROVIDER_INACTIVITY_MS, defaults.inactivityMs), absoluteMs: bounded(process.env[`PROJECT_RELAY_${prefix}_${mode}_MAX_MS`], defaults.absoluteMs) };
}

type LoadedAgentSession = Awaited<ReturnType<typeof loadAgentSession>>;
type LoadedConversation = NonNullable<Awaited<ReturnType<typeof prisma.conversation.findUnique>>>;
type LoadedUserMessage = NonNullable<Awaited<ReturnType<typeof prisma.conversationMessage.findUnique>>>;
type LoadedRoutingDecision = NonNullable<Awaited<ReturnType<typeof prisma.routingDecision.findUnique>>>;
type LoadedProviderSession = NonNullable<Awaited<ReturnType<typeof prisma.providerSession.findUnique>>>;
type LoadedHandoffCapsule = NonNullable<Awaited<ReturnType<typeof prisma.handoffCapsule.findUnique>>>;

function loadAgentSession(id: string) {
  return prisma.agentSession.findUnique({
    where: { id },
    include: { project: { include: { decisions: { where: { status: "ACCEPTED", locked: true } } } }, task: true }
  });
}

function ownershipLifecycle(input: {
  agentSessionId: string;
  providerId: string;
  workerId: string;
}): ProviderProcessLifecycle {
  return {
    async captureProcessStart(pid) {
      const owned = await captureOwnedProcess({
        rootPid: pid,
        agentSessionId: input.agentSessionId,
        providerId: input.providerId,
        workerId: input.workerId,
      });
      return {
        pid: owned.rootPid,
        processStartIdentity: owned.startedAt,
        processStartedAt: new Date(owned.startedAt),
      };
    },
    async onProcessStarted(start) {
      const persisted = await prisma.agentSession.updateMany({
        where: {
          id: input.agentSessionId,
          providerId: input.providerId,
          workerId: input.workerId,
          state: { in: ["STARTING", "RUNNING"] },
        },
        data: {
          providerRootPid: start.pid,
          providerProcessStartedAt: start.processStartedAt,
          providerProcessStartIdentity: start.processStartIdentity,
          state: "RUNNING",
        },
      });
      if (persisted.count !== 1) throw new Error("AgentSession ownership persistence was rejected.");
    },
    async onProcessStartFailure({ pid, start }) {
      const requestedAt = new Date();
      const result = start
        ? await terminateOwnedProcessTree({
            rootPid: pid,
            expectedStartIdentity: start.processStartIdentity,
            agentSessionId: input.agentSessionId,
            reason: "OWNERSHIP_FAILURE",
          })
        : await terminateNewlySpawnedProcessTree(pid);
      await prisma.agentSession.updateMany({
        where: {
          id: input.agentSessionId,
          providerId: input.providerId,
          workerId: input.workerId,
          state: { in: ["STARTING", "RUNNING"] },
        },
        data: {
          state: "FAILED",
          endedAt: new Date(),
          failureCode: "PROVIDER_OWNERSHIP_FAILURE",
          error: "Provider process ownership could not be established.",
          providerTerminationRequestedAt: requestedAt,
          providerTerminationCompletedAt: new Date(),
          providerTerminationReason: "OWNERSHIP_FAILURE",
          providerTerminationResult: result,
          ...releasedLeaseFields,
        },
      });
    },
  };
}

type RecordedTerminationReason = "CANCELLED" | "INACTIVITY_TIMEOUT" | "ABSOLUTE_TIMEOUT";

/**
 * Terminates a provider only after loading the root PID and exact OS start identity
 * recorded for this AgentSession. A PID is never sufficient on its own on Windows.
 * This is deliberately worker-only; browser callers can request cancellation but
 * cannot pass a PID, identity, or termination command.
 */
export async function terminateRecordedProviderProcess(input: {
  agentSessionId: string;
  reason: RecordedTerminationReason;
  targetState?: "TIMED_OUT" | "CANCELLED";
  failureCode?: "PROVIDER_INACTIVITY_TIMEOUT" | "PROVIDER_ABSOLUTE_TIMEOUT" | "PROVIDER_CANCELLED";
  workerId?: string;
}): Promise<"TERMINATED" | "ALREADY_EXITED" | "IDENTITY_MISMATCH" | "OWNERSHIP_MISSING" | "TERMINATION_UNCONFIRMED"> {
  const session = await prisma.agentSession.findUnique({
    where: { id: input.agentSessionId },
    select: {
      providerRootPid: true,
      providerProcessStartIdentity: true,
      state: true,
    },
  });
  if (!session) return "OWNERSHIP_MISSING";

  const requestedAt = new Date();
  await prisma.agentSession.updateMany({
    where: {
      id: input.agentSessionId,
      ...(input.targetState === "TIMED_OUT" ? { state: { in: ["STARTING", "RUNNING"] } } : {}),
      ...(input.workerId ? { workerId: input.workerId } : {}),
    },
    data: {
      ...(input.targetState ? { state: input.targetState, endedAt: requestedAt } : {}),
      ...(input.failureCode ? { failureCode: input.failureCode } : {}),
      ...(input.failureCode === "PROVIDER_INACTIVITY_TIMEOUT"
        ? { error: "The provider stopped producing progress." }
        : input.failureCode === "PROVIDER_ABSOLUTE_TIMEOUT"
          ? { error: "The execution exceeded its maximum allowed duration." }
          : input.failureCode === "PROVIDER_CANCELLED"
            ? { error: "Execution cancelled by user." }
            : {}),
      providerTerminationRequestedAt: requestedAt,
      providerTerminationReason: input.reason,
      ...(input.targetState ? releasedLeaseFields : {}),
    },
  });

  if (!session.providerRootPid || !session.providerProcessStartIdentity) {
    await prisma.agentSession.updateMany({
      where: { id: input.agentSessionId },
      data: {
        failureCode: "PROVIDER_OWNERSHIP_UNPROVEN",
        error: "Provider process termination could not be proven.",
        providerTerminationCompletedAt: new Date(),
        providerTerminationResult: "OWNERSHIP_MISSING",
      },
    });
    return "OWNERSHIP_MISSING";
  }

  let result: "TERMINATED" | "ALREADY_EXITED" | "IDENTITY_MISMATCH" | "TERMINATION_UNCONFIRMED";
  try {
    result = await terminateOwnedProcessTree({
      rootPid: session.providerRootPid,
      expectedStartIdentity: session.providerProcessStartIdentity,
      agentSessionId: input.agentSessionId,
      reason: input.reason,
    });
  } catch {
    result = "TERMINATION_UNCONFIRMED";
  }
  await prisma.agentSession.updateMany({
    where: { id: input.agentSessionId },
    data: {
      ...(result === "IDENTITY_MISMATCH"
        ? {
            failureCode: "PROVIDER_PROCESS_IDENTITY_MISMATCH",
            error: "Provider process identity no longer matches the recorded execution.",
          }
        : result === "TERMINATION_UNCONFIRMED"
          ? {
              failureCode: "PROVIDER_TERMINATION_UNCONFIRMED",
              error: "Provider process termination could not be confirmed.",
            }
        : {}),
      providerTerminationCompletedAt: new Date(),
      providerTerminationResult: result,
    },
  });
  return result;
}

/**
 * The AgentSession is the authority root for a queued conversation execution: every other
 * ID in the job payload is only ever used to *load* a row, never trusted directly. This
 * cross-checks that everything loaded actually belongs together before any provider is
 * touched, so a stale or cross-wired payload (e.g. pointing at another project's task, or
 * a provider session for a different conversation) is rejected instead of silently acted on.
 */
function validateExecutionRelationships(input: {
  data: ConversationMessageJob;
  session: NonNullable<LoadedAgentSession>;
  conversation: LoadedConversation;
  userMessage: LoadedUserMessage;
  routingDecision: LoadedRoutingDecision;
  providerSession: LoadedProviderSession;
  handoffCapsule: LoadedHandoffCapsule | null;
}): string | null {
  const { data, session, conversation, userMessage, routingDecision, providerSession, handoffCapsule } = input;

  if (session.conversationId !== data.conversationId) return "Cross-wired execution: the agent session's conversation does not match the queued job.";
  if (conversation.id !== data.conversationId) return "Cross-wired execution: the loaded conversation does not match the queued conversationId.";
  if (conversation.projectId !== session.projectId) return "Cross-wired execution: the conversation's project does not match the agent session's project.";
  if (session.taskId !== data.taskId) return "Cross-wired execution: the queued taskId does not match the agent session's own task.";
  if (session.task.projectId !== session.projectId) return "Cross-wired execution: the task's project does not match the agent session's project.";
  if (userMessage.conversationId !== conversation.id) return "Cross-wired execution: the user message does not belong to this conversation.";
  if (userMessage.id !== data.messageId) return "Cross-wired execution: the queued messageId does not match the loaded user message.";
  if (session.userMessageId && session.userMessageId !== userMessage.id) return "Cross-wired execution: the agent session's own trigger message does not match the queued messageId.";
  if (data.providerId !== session.providerId) return "Cross-wired execution: the queued providerId does not match the agent session's own provider.";
  if (routingDecision.conversationId !== conversation.id) return "Cross-wired execution: the routing decision does not belong to this conversation.";
  if (routingDecision.userMessageId !== userMessage.id) return "Cross-wired execution: the routing decision is not linked to this user message.";
  if (routingDecision.selectedProviderId !== session.providerId) return "Cross-wired execution: the routing decision's selected provider does not match the agent session's provider.";
  if (providerSession.conversationId !== conversation.id) return "Cross-wired execution: the provider session does not belong to this conversation.";
  if (providerSession.providerId !== session.providerId) return "Cross-wired execution: the provider session's provider does not match the agent session's provider.";
  if (session.providerSessionId && session.providerSessionId !== providerSession.id) return "Cross-wired execution: the agent session's own provider session does not match the queued providerSessionId.";
  if (handoffCapsule) {
    if (handoffCapsule.conversationId !== conversation.id) return "Cross-wired execution: the handoff capsule does not belong to this conversation.";
    if (handoffCapsule.toProviderId !== session.providerId) return "Cross-wired execution: the handoff capsule's target provider does not match the agent session's provider.";
  }
  if (!getProviderModeCapability(session.providerId, userMessage.mode)) return `Unsupported execution: ${session.providerId} does not support ${userMessage.mode} mode.`;
  return null;
}

/**
 * Runs a single provider turn (resumed or fresh) and returns the extracted assistant text.
 * Only "stdout" events become the persisted assistant answer; state/usage/stderr events
 * are diagnostic-only and must never leak into the conversation transcript.
 */
async function executeProviderTurn(input: {
  provider: CodingProvider;
  providerAgentSession: ProviderAgentSession;
  capsule: TaskCapsuleContent;
  resume: boolean;
  timeout: TimeoutPolicy;
  sessionId: string;
  workerId: string;
}): Promise<string> {
  let assistantText = "";
  const controller = new AbortController();
  let timeoutCode: ProviderExecutionTimeout["code"] | undefined;
  let cancellationRequested = false;
  let termination: Promise<unknown> | undefined;
  let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
  const terminate = (reason: RecordedTerminationReason, code: ProviderExecutionTimeout["code"] | "PROVIDER_CANCELLED") => {
    termination ??= terminateRecordedProviderProcess({
      agentSessionId: input.sessionId,
      reason,
      targetState: code === "PROVIDER_CANCELLED" ? "CANCELLED" : "TIMED_OUT",
      failureCode: code,
      workerId: input.workerId,
    });
    controller.abort();
    void input.provider.cancelSession(input.providerAgentSession.id);
  };
  const abort = (code: ProviderExecutionTimeout["code"]) => {
    if (!timeoutCode && !cancellationRequested) {
      timeoutCode = code;
      terminate(code === "PROVIDER_INACTIVITY_TIMEOUT" ? "INACTIVITY_TIMEOUT" : "ABSOLUTE_TIMEOUT", code);
    }
  };
  const activity = () => {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => abort("PROVIDER_INACTIVITY_TIMEOUT"), input.timeout.inactivityMs);
  };
  const cancellationTimer = setInterval(() => {
    void prisma.agentSession.findUnique({ where: { id: input.sessionId }, select: { state: true, workerId: true } })
      .then((session) => {
        if (session?.state === "CANCELLED" && session.workerId === input.workerId && !cancellationRequested) {
          cancellationRequested = true;
          terminate("CANCELLED", "PROVIDER_CANCELLED");
        }
      })
      .catch(() => undefined);
  }, 250);
  cancellationTimer.unref?.();
  activity();
  const absoluteTimer = setTimeout(() => abort("PROVIDER_ABSOLUTE_TIMEOUT"), input.timeout.absoluteMs);
  const consume = (async () => {
    for await (const item of input.provider.streamEvents(input.providerAgentSession.id)) {
      if (item.type === "stdout") assistantText += item.message;
      activity();
      await event(input.sessionId, item.type, item.message, item.type === "stdout" || item.type === "stderr" ? item.type : undefined);
    }
  })();
  // The runner may wait for ownership persistence before startSession resolves. Mark an
  // early stream rejection handled immediately, then rethrow it through `await consume`.
  void consume.catch(() => undefined);
  try {
    if (input.resume) await input.provider.resumeSession(input.providerAgentSession, input.capsule, controller.signal);
    else await input.provider.startSession(input.providerAgentSession, input.capsule, controller.signal);
    await consume;
  } catch (runError) {
    if (termination) await termination;
    if (cancellationRequested) throw new ProviderExecutionCancelled();
    if (timeoutCode) throw new ProviderExecutionTimeout(timeoutCode);
    throw runError;
  } finally {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    clearTimeout(absoluteTimer);
    clearInterval(cancellationTimer);
  }
  if (termination) await termination;
  if (cancellationRequested) throw new ProviderExecutionCancelled();
  if (timeoutCode) throw new ProviderExecutionTimeout(timeoutCode);
  return assistantText;
}

export async function processConversationMessage(job: Job<ConversationMessageJob>, deps: ConversationWorkerDeps = {}): Promise<void> {
  const registry = deps.registry ?? defaultRegistry;
  const workerId = deps.workerId ?? PROCESS_WORKER_ID;
  const leaseMs = deps.leaseMs ?? DEFAULT_LEASE_MS;
  const data = conversationMessageJobSchema.parse(job.data);

  const claimed = await claimAgentSession(data.sessionId, workerId, leaseMs);
  if (!claimed) return;

  const stopHeartbeat = startHeartbeat(data.sessionId, workerId, leaseMs);
  try {
    await processClaimedConversationMessage({
      data,
      registry,
      ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
      ...(deps.timeoutPolicy ? { timeoutPolicy: deps.timeoutPolicy } : {}),
      workerId,
    });
  } finally {
    stopHeartbeat();
  }
}

async function processClaimedConversationMessage(input: {
  data: ConversationMessageJob;
  registry: Pick<ProviderRegistry, "get">;
  timeoutMs?: number;
  timeoutPolicy?: TimeoutPolicy;
  workerId: string;
}): Promise<void> {
  const { data, registry, timeoutMs, timeoutPolicy, workerId } = input;

  const session = await loadAgentSession(data.sessionId);
  if (!session) throw new Error("Queued conversation execution references a missing agent session.");

  const [conversation, userMessage, providerSession] = await Promise.all([
    prisma.conversation.findUniqueOrThrow({ where: { id: data.conversationId } }),
    prisma.conversationMessage.findUniqueOrThrow({ where: { id: data.messageId } }),
    prisma.providerSession.findUniqueOrThrow({ where: { id: data.providerSessionId } })
  ]);
  const routingDecision = await prisma.routingDecision.findUniqueOrThrow({ where: { id: data.routingDecisionId } });
  const handoffCapsule = data.handoffCapsuleId ? await prisma.handoffCapsule.findUnique({ where: { id: data.handoffCapsuleId } }) : null;

  await event(session.id, "state", "Queued conversation execution claimed.");

  const validationError = validateExecutionRelationships({ data, session, conversation, userMessage, routingDecision, providerSession, handoffCapsule });
  if (validationError) {
    await prisma.agentSession.updateMany({ where: { id: session.id, state: "STARTING", workerId }, data: { state: "FAILED", endedAt: new Date(), error: validationError, ...releasedLeaseFields } });
    await event(session.id, "state", validationError);
    throw new Error(validationError);
  }

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

    const role = roleForMode(userMessage.mode);
    const capability = getProviderModeCapability(session.providerId, userMessage.mode);
    if (!capability) throw new Error(`Unsupported execution: ${session.providerId} does not support ${userMessage.mode} mode.`);

    // Resume only the same conversation/provider session: providerSession is already
    // scoped to (conversationId, providerId), so its own externalSessionId (if any) is
    // the prior turn's real external thread id for this exact provider in this exact
    // conversation - never another provider's, another conversation's, or a fabricated one.
    const resumeExternalId = providerSession.externalSessionId ?? undefined;
    let providerAgentSession = await provider.createSession({
      workspace: session.project.repositoryPath,
      taskId: session.taskId,
      capability,
      ...(role ? { role } : {}),
      ...(resumeExternalId ? { resumeExternalId } : {}),
      processLifecycle: ownershipLifecycle({ agentSessionId: session.id, providerId: session.providerId, workerId }),
    });
    await event(session.id, "state", resumeExternalId ? `Resuming ${provider.name} session ${resumeExternalId}.` : `Running ${status.version ?? provider.name}.`);

    let assistantText: string;
    try {
      assistantText = await executeProviderTurn({ provider, providerAgentSession, capsule, resume: Boolean(resumeExternalId), timeout: timeoutPolicy ?? providerTimeoutPolicy(session.providerId, userMessage.mode as ConversationMode, timeoutMs), sessionId: session.id, workerId });
    } catch (runError) {
      if (!resumeExternalId || !(runError instanceof StaleProviderSessionError)) throw runError;
      // The resumed external session is gone: fall back safely to a brand new provider
      // session (never re-throwing the stale id) and record the transition so it's visible
      // in the execution history rather than silently swallowed.
      await event(session.id, "state", `Prior ${provider.name} session ${resumeExternalId} is no longer available; starting a fresh session.`);
      providerAgentSession = await provider.createSession({
        workspace: session.project.repositoryPath,
        taskId: session.taskId,
        capability,
        ...(role ? { role } : {}),
        processLifecycle: ownershipLifecycle({ agentSessionId: session.id, providerId: session.providerId, workerId }),
      });
      assistantText = await executeProviderTurn({ provider, providerAgentSession, capsule, resume: false, timeout: timeoutPolicy ?? providerTimeoutPolicy(session.providerId, userMessage.mode as ConversationMode, timeoutMs), sessionId: session.id, workerId });
    }

    const usage = await provider.getUsage(providerAgentSession.id);
    const redactedOutput = redactSecrets(assistantText || "(no output)").slice(0, MAX_ASSISTANT_MESSAGE_BYTES);
    // Never fall back to the internal session UUID: an absent externalId means the
    // provider genuinely never reported one, and that must be persisted as null.
    const externalSessionId = providerAgentSession.externalId ?? null;

    const completed = await prisma.$transaction(async tx => {
      const finalized = await tx.agentSession.updateMany({
        where: { id: session.id, state: "RUNNING", workerId },
        data: { state: "SUCCEEDED", endedAt: new Date(), exitCode: 0, usage, externalId: externalSessionId, ...releasedLeaseFields }
      });
      if (!finalized.count) return false;
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
      return true;
    });
    if (completed) await event(session.id, "state", "Conversation execution completed.");
  } catch (error) {
    const timeout = error instanceof ProviderExecutionTimeout ? error : undefined;
    const cancelled = error instanceof ProviderExecutionCancelled;
    const code = timeout?.code ?? (cancelled ? "PROVIDER_CANCELLED" : "PROVIDER_PROCESS_ERROR");
    const message = redactSecrets(timeout?.message ?? (cancelled ? "Execution cancelled by user." : error instanceof Error ? error.message : "Provider process failed.")).slice(0, MAX_ASSISTANT_MESSAGE_BYTES);
    await prisma.$transaction(async tx => {
      const finalized = await tx.agentSession.updateMany({ where: { id: session.id, state: { in: ["RUNNING", "STARTING"] }, workerId }, data: { state: timeout ? "TIMED_OUT" : cancelled ? "CANCELLED" : "FAILED", endedAt: new Date(), error: message, failureCode: code, ...releasedLeaseFields } });
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
