-- Denormalized onto ConversationMessage (same pattern as its existing providerId/mode
-- columns) so the timeline UI can show requested/resolved model per assistant message
-- without joining back to AgentSession. Additive and nullable; existing rows unaffected.
ALTER TABLE "ConversationMessage" ADD COLUMN "requestedModel" TEXT;
ALTER TABLE "ConversationMessage" ADD COLUMN "resolvedModel" TEXT;
