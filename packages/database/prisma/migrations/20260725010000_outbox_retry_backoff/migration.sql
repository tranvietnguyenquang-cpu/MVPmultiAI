ALTER TYPE "OutboxEventStatus" ADD VALUE IF NOT EXISTS 'DEAD_LETTER';
ALTER TABLE "OutboxEvent" ADD COLUMN "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, ADD COLUMN "lastErrorCode" TEXT, ADD COLUMN "lastErrorMessage" TEXT;
CREATE INDEX "OutboxEvent_status_nextAttemptAt_idx" ON "OutboxEvent"("status","nextAttemptAt");
