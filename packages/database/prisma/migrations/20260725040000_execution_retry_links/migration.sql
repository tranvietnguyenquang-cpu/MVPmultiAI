DROP INDEX IF EXISTS "AgentSession_userMessageId_key";
DROP INDEX IF EXISTS "RoutingDecision_userMessageId_key";
CREATE INDEX "AgentSession_userMessageId_idx" ON "AgentSession"("userMessageId");
CREATE INDEX "RoutingDecision_userMessageId_idx" ON "RoutingDecision"("userMessageId");
