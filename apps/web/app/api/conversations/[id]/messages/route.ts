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
import { createConversationMessageSchema } from "@project-relay/shared";
import { classifyRequest } from "../../../../../lib/csrf";
import { requireLocalSession } from "../../../../../lib/local-auth";
import { findAccessibleProject } from "../../../../../lib/project-access";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const projectId = request.nextUrl.searchParams.get("projectId");
  if (!projectId) return NextResponse.json({ error: "projectId is required." }, { status: 400 });

  const project = await findAccessibleProject(projectId);
  if (!project) return NextResponse.json({ error: "Project not found." }, { status: 404 });

  const conversation = await getConversationWithDetails(id);
  if (!conversation || conversation.projectId !== project.id) {
    return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
  }

  return NextResponse.json(await listConversationMessages(id));
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

function selectProvider(
  requested: ConversationProviderId | "auto",
  currentProviderId: ConversationProviderId | null,
  health: Record<ConversationProviderId, ProviderHealthEntry>
): { providerId: ConversationProviderId; reason: string } | { error: string } {
  if (requested !== "auto") {
    if (isHealthy(health[requested])) {
      return { providerId: requested, reason: `Explicit selection: ${requested} is installed, authenticated, and available.` };
    }
    return { error: describeUnhealthy(requested, health[requested]) };
  }
  if (currentProviderId && isHealthy(health[currentProviderId])) {
    return { providerId: currentProviderId, reason: `Auto: continuing with the current healthy provider ${currentProviderId}.` };
  }
  const fallback = CONVERSATION_PROVIDER_ORDER.find(id => isHealthy(health[id]));
  if (fallback) {
    return {
      providerId: fallback,
      reason: currentProviderId
        ? `Auto: ${currentProviderId} is unavailable; falling back to the healthy provider ${fallback}.`
        : `Auto: selecting the first healthy configured provider ${fallback}.`
    };
  }
  return { error: "No configured provider is currently installed, authenticated, and available." };
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = classifyRequest(request);
  if (gate === "cross-origin") return NextResponse.json({ error: "Cross-origin requests are not permitted." }, { status: 403 });
  if (gate === "unauthenticated") return NextResponse.json({ error: "Missing or invalid CSRF token." }, { status: 401 });

  const session = await requireLocalSession(request);
  if (!session) return NextResponse.json({ error: "Local session required." }, { status: 401 });

  const { id: conversationId } = await params;

  const body = await request.json().catch(() => null);
  const parsed = createConversationMessageSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid message input." }, { status: 400 });

  const conversation = await getConversationWithDetails(conversationId);
  if (!conversation) return NextResponse.json({ error: "Conversation not found." }, { status: 404 });

  const project = await findAccessibleProject(conversation.projectId);
  if (!project) return NextResponse.json({ error: "Project not found." }, { status: 404 });

  if (parsed.data.taskId) {
    const task = await findProjectTask(parsed.data.taskId, project.id);
    if (!task) return NextResponse.json({ error: "Invalid taskId." }, { status: 400 });
  }

  const previousAssistantMessage = await getPreviousAssistantMessage(conversationId);
  const currentProviderId = (previousAssistantMessage?.providerId ?? null) as ConversationProviderId | null;

  const health = (await getProviderHealthSnapshot([...CONVERSATION_PROVIDER_ORDER])) as Record<ConversationProviderId, ProviderHealthEntry>;

  const selection = selectProvider(parsed.data.provider, currentProviderId, health);
  if ("error" in selection) return NextResponse.json({ error: selection.error }, { status: 409 });

  try {
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
        userMessage: result.userMessage,
        selectedProvider: selection.providerId,
        routingDecision: result.routingDecision,
        providerSession: result.providerSession,
        handoffCapsule: result.handoffCapsule
          ? {
              id: result.handoffCapsule.id,
              conversationId: result.handoffCapsule.conversationId,
              fromProviderId: result.handoffCapsule.fromProviderId,
              toProviderId: result.handoffCapsule.toProviderId,
              version: result.handoffCapsule.version,
              checksum: result.handoffCapsule.checksum,
              createdAt: result.handoffCapsule.createdAt
            }
          : null,
        queuedExecution: { agentSessionId: result.agentSession.id, taskId: result.taskId, state: result.agentSession.state }
      },
      { status: 202 }
    );
  } catch {
    return NextResponse.json({ error: "Could not queue the conversation message." }, { status: 500 });
  }
}
