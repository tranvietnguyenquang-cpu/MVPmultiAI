ALTER TABLE "ConversationMessage" ADD COLUMN "agentSessionId" TEXT;
ALTER TABLE "AgentSession" ADD COLUMN "providerSessionId" TEXT;
CREATE INDEX "ConversationMessage_agentSessionId_idx" ON "ConversationMessage"("agentSessionId");
