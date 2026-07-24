-- Persists the resolved ExecutionCapability ("READ_ONLY" | "WORKSPACE_WRITE") granted to
-- each execution, so Claude's CONTINUE mode can inherit the exact capability of the
-- execution being continued instead of re-deriving it from the mode alone.
-- Nullable for historical rows created before this column existed.
ALTER TABLE "AgentSession" ADD COLUMN "capability" TEXT;
