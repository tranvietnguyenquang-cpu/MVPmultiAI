import { z } from "zod";
import { normalizedTaskSpecSchema, taskSourceSchema } from "@project-relay/relay-v2-domain";

export const v2ProjectInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  slug: z.string().trim().min(1).max(100).optional(),
  localPath: z.string().trim().min(3).max(1024),
  description: z.string().trim().max(2_000).optional()
}).strict();

export const v2HandoffValidationRequestSchema = z.object({
  text: z.string(),
  format: z.enum(["AUTO", "JSON", "YAML"]).default("AUTO"),
  projectId: z.string().uuid().optional()
}).strict();

const milestone1SourceSchema = taskSourceSchema.refine(source => ["MANUAL", "HANDOFF_JSON", "HANDOFF_YAML", "CLIPBOARD", "FILE_IMPORT"].includes(source), "This task source is not available in Milestone 1.");

export const v2TaskCreateRequestSchema = z.object({
  projectId: z.string().uuid(),
  normalized: normalizedTaskSpecSchema,
  source: milestone1SourceSchema,
  externalId: z.string().trim().min(1).max(200).optional(),
  idempotencyKey: z.string().trim().min(1).max(200).optional()
}).strict();

export const v2TaskReplaceRequestSchema = z.object({ normalized: normalizedTaskSpecSchema }).strict();
export const v2TaskResolutionSchema = z.object({ rejected: z.boolean().default(false) }).strict();
export const v2LegacyReportSchema = z.object({
  v2ProjectId: z.string().uuid(),
  legacyProjectIds: z.array(z.string().min(1).max(200)).min(1).max(100)
}).strict();
