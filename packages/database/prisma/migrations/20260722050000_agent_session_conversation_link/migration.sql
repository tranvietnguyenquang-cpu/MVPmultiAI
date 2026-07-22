ALTER TABLE "AgentSession" ADD COLUMN "conversationId" TEXT;
CREATE INDEX "AgentSession_conversationId_idx" ON "AgentSession"("conversationId");
