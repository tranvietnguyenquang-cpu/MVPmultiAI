-- Worker ownership/lease columns for safe multi-worker crash recovery.
ALTER TABLE "AgentSession" ADD COLUMN "workerId" TEXT;
ALTER TABLE "AgentSession" ADD COLUMN "leaseExpiresAt" TIMESTAMP(3);

CREATE INDEX "AgentSession_state_leaseExpiresAt_idx" ON "AgentSession"("state", "leaseExpiresAt");
