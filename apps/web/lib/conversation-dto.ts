import type { ConversationMessage, HandoffCapsule, ProviderSession, RoutingDecision } from "@project-relay/database";

/**
 * Explicit response DTOs for conversation-related API responses. Never spread a raw
 * Prisma row into a response: ProviderSession.externalSessionId (the third-party
 * CLI's own session/thread id) must never reach the browser, and every other model
 * here should only expose the fields the UI actually uses.
 */

export type ProviderSessionDto = { id: string; providerId: string; status: string; startedAt: Date | null; endedAt: Date | null };
export function toProviderSessionDto(session: ProviderSession): ProviderSessionDto {
  return { id: session.id, providerId: session.providerId, status: session.status, startedAt: session.startedAt, endedAt: session.endedAt };
}

export type HandoffCapsuleDto = { id: string; conversationId: string; fromProviderId: string; toProviderId: string; version: number; checksum: string; createdAt: Date };
export function toHandoffCapsuleDto(capsule: HandoffCapsule): HandoffCapsuleDto {
  return {
    id: capsule.id,
    conversationId: capsule.conversationId,
    fromProviderId: capsule.fromProviderId,
    toProviderId: capsule.toProviderId,
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
    createdAt: message.createdAt
  };
}

export type RoutingDecisionDto = {
  id: string;
  conversationId: string;
  userMessageId: string | null;
  requestedProviderId: string | null;
  selectedProviderId: string;
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
    reason: decision.reason,
    providerHealthSnapshot: decision.providerHealthSnapshot,
    createdAt: decision.createdAt
  };
}
