import { notFound } from "next/navigation";
import {
  getActiveConversationExecution,
  getConversationWithDetails,
  getProviderHealthDisplay,
  prisma
} from "@project-relay/database";
import { ConversationChat } from "../../../../../components/conversation-chat";

export const dynamic = "force-dynamic";

export default async function ConversationPage({ params }: { params: Promise<{ id: string; conversationId: string }> }) {
  const { id: projectId, conversationId } = await params;

  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) notFound();

  const conversation = await getConversationWithDetails(conversationId);
  if (!conversation || conversation.projectId !== project.id) notFound();

  const providerHealth = await getProviderHealthDisplay(["codex-cli", "claude-cli"]);
  const activeExecution = await getActiveConversationExecution(conversationId);

  let userIndex = 0;
  const messages = conversation.messages.map(message => {
    const routingDecision = message.role === "USER" ? conversation.routingDecisions[userIndex] : undefined;
    if (message.role === "USER") userIndex += 1;
    return {
      id: message.id,
      role: message.role,
      providerId: message.providerId,
      providerSessionId: message.providerSessionId,
      agentSessionId: message.agentSessionId,
      taskId: message.taskId,
      mode: message.mode,
      content: message.content,
      status: message.status,
      handoffCapsuleId: message.handoffCapsuleId,
      requestedModel: message.requestedModel,
      resolvedModel: message.resolvedModel,
      createdAt: message.createdAt.toISOString(),
      ...(routingDecision
        ? { routing: { requestedProviderId: routingDecision.requestedProviderId, selectedProviderId: routingDecision.selectedProviderId } }
        : {})
    };
  });

  const handoffCapsules = conversation.handoffCapsules.map(capsule => ({
    id: capsule.id,
    fromProviderId: capsule.fromProviderId,
    toProviderId: capsule.toProviderId,
    version: capsule.version,
    checksum: capsule.checksum,
    sourceMessageRange: capsule.sourceMessageRange as { fromMessageId: string; toMessageId: string },
    sizeBytes: Buffer.byteLength(JSON.stringify(capsule)),
    createdAt: capsule.createdAt.toISOString()
  }));

  const providerSessions = conversation.providerSessions.map(session => ({
    id: session.id,
    providerId: session.providerId,
    status: session.status,
    resolvedModel: session.resolvedModel
  }));

  return (
    <>
      <div className="eyebrow">{project.name} / Conversation</div>
      <h1>{conversation.title}</h1>
      <ConversationChat
        projectId={project.id}
        conversationId={conversation.id}
        conversationTitle={conversation.title}
        messages={messages}
        handoffCapsules={handoffCapsules}
        providerSessions={providerSessions}
        providerHealth={providerHealth}
        initialActiveExecutionId={activeExecution?.id ?? null}
      />
    </>
  );
}
