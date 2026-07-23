ALTER TABLE "AgentSession"
  ADD COLUMN "providerRootPid" INTEGER,
  ADD COLUMN "providerProcessStartedAt" TIMESTAMP(3),
  ADD COLUMN "providerTerminationRequestedAt" TIMESTAMP(3),
  ADD COLUMN "providerTerminationCompletedAt" TIMESTAMP(3),
  ADD COLUMN "providerTerminationReason" TEXT,
  ADD COLUMN "providerTerminationResult" TEXT;
