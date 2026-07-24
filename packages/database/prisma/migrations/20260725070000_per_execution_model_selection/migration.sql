-- Per-execution model selection (Codex CLI / Claude Code). Purely additive: every new
-- column is nullable and every new table is new, so existing rows are preserved unchanged.

CREATE TYPE "ModelSource" AS ENUM ('USER_SELECTED', 'PROJECT_DEFAULT', 'SYSTEM_DEFAULT', 'PROVIDER_DEFAULT');
CREATE TYPE "ModelAvailabilityStatus" AS ENUM ('AVAILABLE', 'UNSUPPORTED', 'NOT_AUTHENTICATED', 'RATE_LIMITED', 'NETWORK_ERROR', 'UNKNOWN');

ALTER TABLE "Project" ADD COLUMN "defaultClaudeModel" TEXT;
ALTER TABLE "Project" ADD COLUMN "defaultCodexModel" TEXT;
ALTER TABLE "Project" ADD COLUMN "defaultCodexReasoningEffort" TEXT;

ALTER TABLE "ProviderSession" ADD COLUMN "resolvedModel" TEXT;
ALTER TABLE "ProviderSession" ADD COLUMN "reasoningEffort" TEXT;

ALTER TABLE "HandoffCapsule" ADD COLUMN "fromModel" TEXT;
ALTER TABLE "HandoffCapsule" ADD COLUMN "toModel" TEXT;

ALTER TABLE "RoutingDecision" ADD COLUMN "requestedModel" TEXT;
ALTER TABLE "RoutingDecision" ADD COLUMN "selectedModel" TEXT;

ALTER TABLE "AgentSession" ADD COLUMN "requestedModel" TEXT;
ALTER TABLE "AgentSession" ADD COLUMN "resolvedModel" TEXT;
ALTER TABLE "AgentSession" ADD COLUMN "reasoningEffort" TEXT;
ALTER TABLE "AgentSession" ADD COLUMN "modelSource" "ModelSource";
ALTER TABLE "AgentSession" ADD COLUMN "providerVersion" TEXT;
ALTER TABLE "AgentSession" ADD COLUMN "resolvedAt" TIMESTAMP(3);

CREATE TABLE "ModelHealth" (
  "providerId" TEXT NOT NULL,
  "modelId" TEXT NOT NULL,
  "reasoningEffort" TEXT,
  "status" "ModelAvailabilityStatus" NOT NULL DEFAULT 'UNKNOWN',
  "reason" TEXT,
  "checkedAt" TIMESTAMP(3),
  "checkInProgress" BOOLEAN NOT NULL DEFAULT false,
  "checkStartedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  PRIMARY KEY ("providerId", "modelId")
);

CREATE TABLE "ApplicationSettings" (
  "id" TEXT PRIMARY KEY DEFAULT 'singleton',
  "defaultClaudeModel" TEXT,
  "defaultCodexModel" TEXT,
  "defaultCodexReasoningEffort" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
