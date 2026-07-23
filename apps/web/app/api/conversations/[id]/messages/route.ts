import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  findProjectTask,
  getConversationWithDetails,
  getPreviousAssistantMessage,
  getProviderHealthSnapshot,
  listConversationMessages,
  queueConversationMessage
} from "@project-relay/database";
import { createConversationMessageSchema, getProviderModeCapability } from "@project-relay/shared";
import { ApiError, apiErrorResponse } from "../../../../../lib/api-errors";
import { toConversationMessageDto, toHandoffCapsuleDto, toProviderSessionDto, toRoutingDecisionDto } from "../../../../../lib/conversation-dto";
import { classifyRequest } from "../../../../../lib/csrf";
import { requireLocalSession } from "../../../../../lib/local-auth";
import { findAccessibleProject } from "../../../../../lib/project-access";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const projectId = request.nextUrl.searchParams.get("projectId");
    if (!projectId) throw new ApiError("VALIDATION_ERROR", "projectId is required.");

    const project = await findAccessibleProject(projectId);
    if (!project) throw new ApiError("NOT_FOUND", "Project not found.");

    const conversation = await getConversationWithDetails(id);
    if (!conversation || conversation.projectId !== project.id) throw new ApiError("NOT_FOUND", "Conversation not found.");

    const messages = await listConversationMessages(id);
    return NextResponse.json(messages.map(toConversationMessageDto));
  } catch (error) {
    return apiErrorResponse(error, "GET /api/conversations/[id]/messages");
  }
}

const CONVERSATION_PROVIDER_ORDER = ["codex-cli", "claude-cli"] as const;
type ConversationProviderId = (typeof CONVERSATION_PROVIDER_ORDER)[number];
type ProviderHealthEntry = { installed: boolean; authentication: string; available: boolean };

function isHealthy(entry: ProviderHealthEntry | undefined): boolean {
  return Boolean(entry && entry.installed && entry.authentication === "AUTHENTICATED" && entry.available);
}

function describeUnhealthy(providerId: ConversationProviderId, entry: ProviderHealthEntry | undefined): string {
  if (!entry || !entry.installed) return `${providerId} is not installed.`;
  if (entry.authentication !== "AUTHENTICATED") return `${providerId} is not authenticated (status: ${entry.authentication}).`;
  return `${providerId} is not currently available.`;
}

function isCapable(providerId: ConversationProviderId, mode: string): boolean {
  return getProviderModeCapability(providerId, mode) !== null;
}

function selectProvider(
  requested: ConversationProviderId | "auto",
  currentProviderId: ConversationProviderId | null,
  health: Record<ConversationProviderId, ProviderHealthEntry>,
  mode: string
): { providerId: ConversationProviderId; reason: string } | { error: string } {
  if (requested !== "auto") {
    if (!isCapable(requested, mode)) return { error: `${requested} does not support ${mode} execution.` };
    if (isHealthy(health[requested])) {
      return { providerId: requested, reason: `Explicit selection: ${requested} is installed, authenticated, and available.` };
    }
    return { error: describeUnhealthy(requested, health[requested]) };
  }
  if (currentProviderId && isCapable(currentProviderId, mode) && isHealthy(health[currentProviderId])) {
    return { providerId: currentProviderId, reason: `Auto: continuing with the current healthy provider ${currentProviderId}.` };
  }
  const fallback = CONVERSATION_PROVIDER_ORDER.find(id => isCapable(id, mode) && isHealthy(health[id]));
  if (fallback) {
    return {
      providerId: fallback,
      reason: currentProviderId
        ? `Auto: ${currentProviderId} is unavailable or incapable of ${mode}; falling back to the healthy provider ${fallback}.`
        : `Auto: selecting the first healthy configured provider ${fallback}.`
    };
  }
  return { error: `No configured provider capable of ${mode} execution is currently installed, authenticated, and available.` };
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const gate = classifyRequest(request);
    if (gate === "cross-origin") throw new ApiError("FORBIDDEN", "Cross-origin requests are not permitted.");
    if (gate === "unauthenticated") throw new ApiError("UNAUTHENTICATED", "Missing or invalid CSRF token.");

    const session = await requireLocalSession(request);
    if (!session) throw new ApiError("UNAUTHENTICATED", "Local session required.");

    const { id: conversationId } = await params;

    const body = await request.json().catch(() => null);
    const parsed = createConversationMessageSchema.safeParse(body);
    if (!parsed.success) throw new ApiError("VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid message input.");

    const conversation = await getConversationWithDetails(conversationId);
    if (!conversation) throw new ApiError("NOT_FOUND", "Conversation not found.");

    const project = await findAccessibleProject(conversation.projectId);
    if (!project) throw new ApiError("NOT_FOUND", "Project not found.");

    if (parsed.data.taskId) {
      const task = await findProjectTask(parsed.data.taskId, project.id);
      if (!task) throw new ApiError("VALIDATION_ERROR", "Invalid taskId.");
    }

    const previousAssistantMessage = await getPreviousAssistantMessage(conversationId);
    const currentProviderId = (previousAssistantMessage?.providerId ?? null) as ConversationProviderId | null;

    const health = (await getProviderHealthSnapshot([...CONVERSATION_PROVIDER_ORDER])) as Record<ConversationProviderId, ProviderHealthEntry>;

    const selection = selectProvider(parsed.data.provider, currentProviderId, health, parsed.data.mode);
    if ("error" in selection) throw new ApiError("CONFLICT", selection.error);

    const result = await queueConversationMessage({
      conversationId,
      projectId: project.id,
      content: parsed.data.content,
      mode: parsed.data.mode,
      ...(parsed.data.taskId ? { taskId: parsed.data.taskId } : {}),
      selectedProviderId: selection.providerId,
      ...(parsed.data.provider !== "auto" ? { requestedProviderId: parsed.data.provider } : {}),
      reason: selection.reason,
      providerHealthSnapshot: health,
      previousAssistantMessage,
      idempotencyKey: parsed.data.idempotencyKey ?? randomUUID()
    });

    return NextResponse.json(
      {
        duplicate: result.duplicate,
        userMessage: toConversationMessageDto(result.userMessage),
        selectedProvider: selection.providerId,
        routingDecision: result.routingDecision ? toRoutingDecisionDto(result.routingDecision) : null,
        providerSession: result.providerSession ? toProviderSessionDto(result.providerSession) : null,
        handoffCapsule: result.handoffCapsule ? toHandoffCapsuleDto(result.handoffCapsule) : null,
        queuedExecution: { agentSessionId: result.agentSession.id, taskId: result.taskId, state: result.agentSession.state }
      },
      { status: 202 }
    );
  } catch (error) {
    return apiErrorResponse(error, "POST /api/conversations/[id]/messages");
  }
}
