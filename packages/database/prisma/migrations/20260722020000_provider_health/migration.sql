CREATE TYPE "ProviderAuthenticationStatus" AS ENUM ('AUTHENTICATED', 'NOT_AUTHENTICATED', 'RATE_LIMITED', 'NETWORK_ERROR', 'CLI_ERROR', 'UNKNOWN');
CREATE TYPE "QuotaSource" AS ENUM ('CLI_STATUS', 'PROVIDER_RESPONSE', 'LOCAL_ESTIMATE', 'USER_INPUT', 'OFFICIAL_API');
CREATE TABLE "ProviderHealth" (
  "providerId" TEXT PRIMARY KEY,
  "installed" BOOLEAN NOT NULL DEFAULT false,
  "version" TEXT,
  "authentication" "ProviderAuthenticationStatus" NOT NULL DEFAULT 'UNKNOWN',
  "available" BOOLEAN NOT NULL DEFAULT false,
  "latencyMs" INTEGER,
  "lastChecked" TIMESTAMP(3),
  "lastAuthenticationCheck" TIMESTAMP(3),
  "lastSuccessfulRequest" TIMESTAMP(3),
  "lastRateLimitResponse" TIMESTAMP(3),
  "resetAt" TIMESTAMP(3),
  "remainingPercent" DOUBLE PRECISION,
  "quotaSource" "QuotaSource" NOT NULL DEFAULT 'CLI_STATUS',
  "quotaConfidence" "Confidence" NOT NULL DEFAULT 'LOW',
  "quotaExact" BOOLEAN NOT NULL DEFAULT false,
  "checkInProgress" BOOLEAN NOT NULL DEFAULT false,
  "checkStartedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE TABLE "ProviderHealthCheck" ("id" TEXT PRIMARY KEY,"providerId" TEXT NOT NULL,"mode" TEXT NOT NULL,"authentication" "ProviderAuthenticationStatus" NOT NULL,"installed" BOOLEAN NOT NULL,"available" BOOLEAN NOT NULL,"latencyMs" INTEGER,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX "ProviderHealthCheck_providerId_createdAt_idx" ON "ProviderHealthCheck"("providerId", "createdAt");
