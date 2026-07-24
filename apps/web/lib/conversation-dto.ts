import type { ConversationMessage, HandoffCapsule, ProviderSession, RoutingDecision } from "@project-relay/database";

/**
 * Explicit response DTOs for conversation-related API responses. Never spread a raw
 * Prisma row into a response: ProviderSession.externalSessionId (the third-party
 * CLI's own session/thread id) must never reach the browser, and every other model
 * here should only expose the fields the UI actually uses.
 */

export type ProviderSessionDto = { id: string; providerId: string; status: string; resolvedModel: string | null; reasoningEffort: string | null; startedAt: Date | null; endedAt: Date | null };
export function toProviderSessionDto(session: ProviderSession): ProviderSessionDto {
  return { id: session.id, providerId: session.providerId, status: session.status, resolvedModel: session.resolvedModel, reasoningEffort: session.reasoningEffort, startedAt: session.startedAt, endedAt: session.endedAt };
}

export type HandoffCapsuleDto = { id: string; conversationId: string; fromProviderId: string; toProviderId: string; fromModel: string | null; toModel: string | null; version: number; checksum: string; createdAt: Date };
export function toHandoffCapsuleDto(capsule: HandoffCapsule): HandoffCapsuleDto {
  return {
    id: capsule.id,
    conversationId: capsule.conversationId,
    fromProviderId: capsule.fromProviderId,
    toProviderId: capsule.toProviderId,
    fromModel: capsule.fromModel,
    toModel: capsule.toModel,
    version: capsule.version,
    checksum: capsule.checksum,
    createdAt: capsule.createdAt
  };
}

export type ConversationMessageDto = {
  id: string;
  conversationId: string;
  role: string;
  providerId: string | null;
  providerSessionId: string | null;
  mode: string;
  content: string;
  status: string;
  handoffCapsuleId: string | null;
  taskId: string | null;
  agentSessionId: string | null;
  requestedModel: string | null;
  resolvedModel: string | null;
  createdAt: Date;
};
export function toConversationMessageDto(message: ConversationMessage): ConversationMessageDto {
  return {
    id: message.id,
    conversationId: message.conversationId,
    role: message.role,
    providerId: message.providerId,
    providerSessionId: message.providerSessionId,
    mode: message.mode,
    content: message.content,
    status: message.status,
    handoffCapsuleId: message.handoffCapsuleId,
    taskId: message.taskId,
    agentSessionId: message.agentSessionId,
    requestedModel: message.requestedModel,
    resolvedModel: message.resolvedModel,
    createdAt: message.createdAt
  };
}

export type RoutingDecisionDto = {
  id: string;
  conversationId: string;
  userMessageId: string | null;
  requestedProviderId: string | null;
  selectedProviderId: string;
  requestedModel: string | null;
  selectedModel: string | null;
  reason: string;
  providerHealthSnapshot: unknown;
  createdAt: Date;
};
export function toRoutingDecisionDto(decision: RoutingDecision): RoutingDecisionDto {
  return {
    id: decision.id,
    conversationId: decision.conversationId,
    userMessageId: decision.userMessageId,
    requestedProviderId: decision.requestedProviderId,
    selectedProviderId: decision.selectedProviderId,
    requestedModel: decision.requestedModel,
    selectedModel: decision.selectedModel,
    reason: decision.reason,
    providerHealthSnapshot: decision.providerHealthSnapshot,
    createdAt: decision.createdAt
  };
}
