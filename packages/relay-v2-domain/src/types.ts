import { z } from "zod";

export const taskSourceSchema = z.enum([
  "MANUAL",
  "HANDOFF_JSON",
  "HANDOFF_YAML",
  "CLIPBOARD",
  "FILE_IMPORT",
  "LEGACY_PREVIEW",
  "MCP",
  "CHATGPT"
]);
export type TaskSource = z.infer<typeof taskSourceSchema>;

export const taskTypeSchema = z.enum([
  "IMPLEMENTATION",
  "BUGFIX",
  "DOCUMENTATION",
  "ANALYSIS",
  "MIGRATION",
  "SECURITY",
  "OPERATIONS",
  "OTHER"
]);
export type TaskType = z.infer<typeof taskTypeSchema>;

export const taskComplexitySchema = z.enum(["TRIVIAL", "NORMAL", "COMPLEX", "CRITICAL"]);
export type TaskComplexity = z.infer<typeof taskComplexitySchema>;

export const taskStatusSchema = z.enum([
  "DRAFT",
  "PENDING_APPROVAL",
  "APPROVED",
  "QUEUED",
  "RUNNING",
  "AWAITING_REVIEW",
  "REVIEW_FAILED",
  "AWAITING_USER_ACCEPTANCE",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "BLOCKED"
]);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const executorSelectionSchema = z.enum(["AUTO", "FAKE", "CODEX", "CLAUDE"]);
export type ExecutorSelection = z.infer<typeof executorSelectionSchema>;

export const modelSelectionSchema = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9._:/-]+$/, "Model must be AUTO or a simple provider model identifier.");
export type ModelSelection = z.infer<typeof modelSelectionSchema>;

export const reasoningEffortSchema = z.enum(["AUTO", "LOW", "MEDIUM", "HIGH"]);
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;

export const reviewerSelectionSchema = z.enum(["NONE", "AUTO", "CODEX", "CLAUDE"]);
export type ReviewerSelection = z.infer<typeof reviewerSelectionSchema>;

export const approvalStatusSchema = z.enum(["PENDING", "APPROVED", "REJECTED", "INVALIDATED"]);
export type ApprovalStatus = z.infer<typeof approvalStatusSchema>;

export const riskLevelSchema = z.enum(["SAFE", "REVIEW", "DANGEROUS", "BLOCKED"]);
export type RiskLevel = z.infer<typeof riskLevelSchema>;

export const auditActionSchema = z.enum([
  "PROJECT_CREATED",
  "HANDOFF_VALIDATION_FAILED",
  "TASK_CREATED",
  "TASK_DUPLICATE_RETURNED",
  "TASK_SUBMITTED_FOR_APPROVAL",
  "TASK_APPROVED",
  "TASK_REJECTED",
  "TASK_CANCELLED",
  "TASK_APPROVAL_INVALIDATED",
  "TASK_INVALID_TRANSITION_ATTEMPT",
  "LEGACY_REPORT_ATTEMPTED",
  "EXECUTION_REQUEST_AUTHORIZED",
  "EXECUTION_REQUEST_REJECTED",
  "EXECUTION_CANCELLATION_AUTHORIZED",
  "EXECUTION_STALE_RECOVERY",
  "EXECUTION_INVALID_TRANSITION_ATTEMPT"
]);
export type AuditAction = z.infer<typeof auditActionSchema>;
