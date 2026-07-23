-- Preserve the exact OS process-start identity used with a PID to prevent PID reuse.
-- Nullable for historical sessions and sessions which never spawned a provider process.
ALTER TABLE "AgentSession" ADD COLUMN "providerProcessStartIdentity" TEXT;
