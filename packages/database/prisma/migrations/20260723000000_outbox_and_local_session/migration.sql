CREATE TYPE "OutboxEventStatus" AS ENUM ('PENDING','DISPATCHING','PUBLISHED','FAILED');
CREATE TABLE "OutboxEvent" (
  "id" TEXT NOT NULL,
  "topic" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "status" "OutboxEventStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "publishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OutboxEvent_jobId_key" ON "OutboxEvent"("jobId");
CREATE INDEX "OutboxEvent_status_createdAt_idx" ON "OutboxEvent"("status","createdAt");

CREATE TABLE "LocalSession" (
  "id" TEXT NOT NULL,
  "token" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" TIMESTAMP(3),
  CONSTRAINT "LocalSession_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LocalSession_token_key" ON "LocalSession"("token");
