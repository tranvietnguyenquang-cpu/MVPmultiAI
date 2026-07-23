-- Serialization / idempotency columns
ALTER TABLE "Conversation" ADD COLUMN "sequence" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Conversation" ADD COLUMN "handoffSequence" INTEGER NOT NULL DEFAULT 0;
-- Preserve continuity for conversations that already have handoff capsules from before this migration.
UPDATE "Conversation" c SET "handoffSequence" = COALESCE((SELECT MAX(h."version") FROM "HandoffCapsule" h WHERE h."conversationId" = c."id"), 0);

ALTER TABLE "ConversationMessage" ADD COLUMN "idempotencyKey" TEXT;

-- New explicit relation columns
ALTER TABLE "AgentSession" ADD COLUMN "userMessageId" TEXT;
ALTER TABLE "RoutingDecision" ADD COLUMN "userMessageId" TEXT;

-- Replace the old plain index with the unique constraint that also enforces
-- "unique assistant message per AgentSession".
DROP INDEX IF EXISTS "ConversationMessage_agentSessionId_idx";

-- Uniqueness constraints
CREATE UNIQUE INDEX "ConversationMessage_agentSessionId_key" ON "ConversationMessage"("agentSessionId");
CREATE UNIQUE INDEX "ConversationMessage_conversationId_idempotencyKey_key" ON "ConversationMessage"("conversationId","idempotencyKey");
CREATE UNIQUE INDEX "AgentSession_userMessageId_key" ON "AgentSession"("userMessageId");
CREATE UNIQUE INDEX "RoutingDecision_userMessageId_key" ON "RoutingDecision"("userMessageId");
CREATE UNIQUE INDEX "ProviderSession_lastMessageId_key" ON "ProviderSession"("lastMessageId");

-- One active (RUNNING) provider session per conversation/provider scope. This is a
-- partial index because Prisma's schema DSL cannot express a filtered unique
-- constraint directly.
CREATE UNIQUE INDEX "ProviderSession_active_conversation_provider_key"
  ON "ProviderSession"("conversationId","providerId")
  WHERE "status" = 'RUNNING';

-- Foreign keys: message-providerSession, message-handoff, message-task, message-agentSession
ALTER TABLE "ConversationMessage" ADD CONSTRAINT "ConversationMessage_providerSessionId_fkey" FOREIGN KEY ("providerSessionId") REFERENCES "ProviderSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ConversationMessage" ADD CONSTRAINT "ConversationMessage_handoffCapsuleId_fkey" FOREIGN KEY ("handoffCapsuleId") REFERENCES "HandoffCapsule"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ConversationMessage" ADD CONSTRAINT "ConversationMessage_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ConversationMessage" ADD CONSTRAINT "ConversationMessage_agentSessionId_fkey" FOREIGN KEY ("agentSessionId") REFERENCES "AgentSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Foreign keys: agentSession-conversation, agentSession-providerSession, agentSession-userMessage (trigger message)
ALTER TABLE "AgentSession" ADD CONSTRAINT "AgentSession_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AgentSession" ADD CONSTRAINT "AgentSession_providerSessionId_fkey" FOREIGN KEY ("providerSessionId") REFERENCES "ProviderSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AgentSession" ADD CONSTRAINT "AgentSession_userMessageId_fkey" FOREIGN KEY ("userMessageId") REFERENCES "ConversationMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Foreign keys: routingDecision-userMessage, providerSession-lastMessage
ALTER TABLE "RoutingDecision" ADD CONSTRAINT "RoutingDecision_userMessageId_fkey" FOREIGN KEY ("userMessageId") REFERENCES "ConversationMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProviderSession" ADD CONSTRAINT "ProviderSession_lastMessageId_fkey" FOREIGN KEY ("lastMessageId") REFERENCES "ConversationMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;
