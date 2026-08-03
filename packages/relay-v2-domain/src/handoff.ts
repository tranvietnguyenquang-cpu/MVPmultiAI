import { createHash } from "node:crypto";
import { parseDocument } from "yaml";
import { z } from "zod";
import {
  executorSelectionSchema,
  modelSelectionSchema,
  reasoningEffortSchema,
  reviewerSelectionSchema,
  taskComplexitySchema,
  taskTypeSchema
} from "./types.js";

export const MAX_HANDOFF_BYTES = 256 * 1024;

const boundedText = (label: string, max: number) => z.string({ required_error: `${label} is required.` }).trim().min(1, `${label} is required.`).max(max, `${label} must be ${max} characters or fewer.`);

const modelInputSchema = z.union([
  z.literal("auto"),
  z.literal("default"),
  modelSelectionSchema
]);

export const verificationOperationSchema = z.enum(["NPM_TEST", "NPM_TYPECHECK", "NPM_BUILD"]);
export type VerificationOperation = z.infer<typeof verificationOperationSchema>;

export const taskPermissionSchema = z.discriminatedUnion("permission", [
  z.object({ permission: z.literal("ALLOW_SOURCE_TRANSMISSION_TO_API"), value: z.boolean() }).strict(),
  z.object({ permission: z.literal("WORKSPACE_WRITE"), value: z.boolean() }).strict(),
  z.object({ permission: z.literal("NON_PRODUCTION_CONFIRMED"), value: z.boolean() }).strict(),
  z.object({ permission: z.literal("ALLOW_DIRTY_WORKSPACE"), value: z.boolean() }).strict(),
  z.object({ permission: z.literal("TIMEOUT_SECONDS"), value: z.number().int().min(60).max(7_200) }).strict(),
  z.object({ permission: z.literal("VERIFICATION_OPERATIONS"), value: z.array(verificationOperationSchema).max(3) }).strict()
]);
export type TaskPermissionValue = z.infer<typeof taskPermissionSchema>;

export type ExecutionPolicy = {
  workspaceWrite: boolean;
  nonProductionConfirmed: boolean;
  allowDirtyWorkspace: boolean;
  timeoutSeconds: number;
  verificationOperations: VerificationOperation[];
};

export function executionPolicyFromPermissions(permissions: readonly TaskPermissionValue[]): ExecutionPolicy {
  const value = (permission: TaskPermissionValue["permission"]): unknown => permissions.find(item => item.permission === permission)?.value;
  return {
    workspaceWrite: value("WORKSPACE_WRITE") === true,
    nonProductionConfirmed: value("NON_PRODUCTION_CONFIRMED") === true,
    allowDirtyWorkspace: value("ALLOW_DIRTY_WORKSPACE") === true,
    timeoutSeconds: typeof value("TIMEOUT_SECONDS") === "number" ? value("TIMEOUT_SECONDS") as number : 1_800,
    verificationOperations: z.array(verificationOperationSchema).parse(value("VERIFICATION_OPERATIONS") ?? [])
  };
}

export const relayHandoffV1Schema = z.object({
  version: z.literal(1, { errorMap: () => ({ message: "version must be 1." }) }),
  project: z.object({
    name: boundedText("project.name", 100),
    pathHint: z.string().trim().min(3).max(1024).optional()
  }).strict(),
  task: z.object({
    title: boundedText("task.title", 200),
    objective: boundedText("task.objective", 10_000),
    taskType: z.enum(["implementation", "bugfix", "documentation", "analysis", "migration", "security", "operations", "other"]),
    complexity: z.enum(["trivial", "normal", "complex", "critical"]),
    context: z.string().trim().max(50_000).default("")
  }).strict(),
  constraints: z.array(boundedText("constraint", 2_000)).max(100).default([]),
  acceptanceCriteria: z.array(boundedText("acceptance criterion", 2_000)).min(1, "At least one acceptance criterion is required.").max(100),
  execution: z.object({
    executor: z.enum(["auto", "fake", "codex", "claude"]).default("fake"),
    model: modelInputSchema.default("auto"),
    effort: z.enum(["auto", "low", "medium", "high"]).default("auto"),
    reviewer: z.enum(["none", "auto", "codex", "claude"]).default("auto"),
    requireApproval: z.literal(true, { errorMap: () => ({ message: "Relay v2 requires execution.requireApproval to be true." }) }).default(true),
    allowSourceTransmissionToApi: z.boolean().default(false),
    workspaceWrite: z.boolean().default(false),
    nonProductionConfirmed: z.boolean().default(false),
    allowDirtyWorkspace: z.boolean().default(false),
    timeoutSeconds: z.number().int().min(60).max(7_200).default(1_800),
    verificationOperations: z.array(verificationOperationSchema).max(3).default([])
  }).strict().default({
    executor: "fake",
    model: "auto",
    effort: "auto",
    reviewer: "auto",
    requireApproval: true,
    allowSourceTransmissionToApi: false,
    workspaceWrite: false,
    nonProductionConfirmed: false,
    allowDirtyWorkspace: false,
    timeoutSeconds: 1_800,
    verificationOperations: []
  })
}).strict();

export type RelayHandoffV1 = z.infer<typeof relayHandoffV1Schema>;

const likelySecretPattern = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/-]{16,}|\b(?:sk|ghp|github_pat)[-_][A-Za-z0-9_-]{16,}|\b(?:api[_-]?key|token|password|passwd|client[_-]?secret)\s*[:=]\s*[^\s,;]{8,}|\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s:@]+:[^\s@]+@/i;

export const normalizedTaskSpecSchema = z.object({
  version: z.literal(1),
  project: z.object({ name: boundedText("project.name", 100), pathHint: z.string().trim().min(3).max(1024).optional() }).strict(),
  task: z.object({
    title: boundedText("task.title", 200),
    objective: boundedText("task.objective", 10_000),
    taskType: taskTypeSchema,
    complexity: taskComplexitySchema,
    context: z.string().max(50_000)
  }).strict(),
  constraints: z.array(boundedText("constraint", 2_000)).max(100),
  acceptanceCriteria: z.array(boundedText("acceptance criterion", 2_000)).min(1).max(100),
  execution: z.object({
    executor: executorSelectionSchema,
    model: modelSelectionSchema,
    effort: reasoningEffortSchema,
    reviewer: reviewerSelectionSchema,
    requireApproval: z.literal(true)
  }).strict(),
  permissions: z.array(taskPermissionSchema).min(1).max(6).superRefine((permissions, context) => {
    const seen = new Set<string>();
    permissions.forEach((permission, index) => {
      if (seen.has(permission.permission)) context.addIssue({ code: z.ZodIssueCode.custom, path: [index, "permission"], message: "Permission entries must be unique." });
      seen.add(permission.permission);
    });
  })
}).strict().superRefine((spec, context) => {
  const fields: Array<{ path: Array<string | number>; value: string }> = [
    { path: ["task", "title"], value: spec.task.title },
    { path: ["task", "objective"], value: spec.task.objective },
    { path: ["task", "context"], value: spec.task.context },
    ...spec.constraints.map((value, index) => ({ path: ["constraints", index], value })),
    ...spec.acceptanceCriteria.map((value, index) => ({ path: ["acceptanceCriteria", index], value }))
  ];
  for (const field of fields) {
    if (likelySecretPattern.test(field.value)) context.addIssue({ code: z.ZodIssueCode.custom, path: field.path, message: "Possible secret detected. Remove credentials before creating the task." });
  }
});

export type NormalizedTaskSpec = z.infer<typeof normalizedTaskSpecSchema>;

export type HandoffFormat = "JSON" | "YAML";
export type ValidationIssue = { path: string; message: string };

export class HandoffValidationError extends Error {
  constructor(readonly issues: ValidationIssue[]) {
    super(issues.map(issue => `${issue.path}: ${issue.message}`).join("\n"));
    this.name = "HandoffValidationError";
  }
}

function cleanText(value: string): string {
  return value.replace(/\r\n?/g, "\n").trim();
}

function uniqueClean(values: string[]): string[] {
  const seen = new Set<string>();
  return values.map(cleanText).filter(value => {
    const key = value.toLocaleLowerCase("en-US");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeModel(value: string): string {
  const lower = value.toLowerCase();
  if (lower === "auto") return "AUTO";
  if (lower === "default") return "DEFAULT";
  return value;
}

export function normalizeHandoff(handoff: RelayHandoffV1): NormalizedTaskSpec {
  const normalized: NormalizedTaskSpec = {
    version: 1,
    project: {
      name: cleanText(handoff.project.name),
      ...(handoff.project.pathHint ? { pathHint: cleanText(handoff.project.pathHint) } : {})
    },
    task: {
      title: cleanText(handoff.task.title),
      objective: cleanText(handoff.task.objective),
      taskType: taskTypeSchema.parse(handoff.task.taskType.toUpperCase()),
      complexity: taskComplexitySchema.parse(handoff.task.complexity.toUpperCase()),
      context: cleanText(handoff.task.context)
    },
    constraints: uniqueClean(handoff.constraints),
    acceptanceCriteria: uniqueClean(handoff.acceptanceCriteria),
    execution: {
      executor: executorSelectionSchema.parse(handoff.execution.executor.toUpperCase()),
      model: normalizeModel(handoff.execution.model),
      effort: reasoningEffortSchema.parse(handoff.execution.effort.toUpperCase()),
      reviewer: reviewerSelectionSchema.parse(handoff.execution.reviewer.toUpperCase()),
      requireApproval: true
    },
    permissions: [
      { permission: "ALLOW_SOURCE_TRANSMISSION_TO_API", value: handoff.execution.allowSourceTransmissionToApi },
      { permission: "WORKSPACE_WRITE", value: handoff.execution.workspaceWrite },
      { permission: "NON_PRODUCTION_CONFIRMED", value: handoff.execution.nonProductionConfirmed },
      { permission: "ALLOW_DIRTY_WORKSPACE", value: handoff.execution.allowDirtyWorkspace },
      { permission: "TIMEOUT_SECONDS", value: handoff.execution.timeoutSeconds },
      { permission: "VERIFICATION_OPERATIONS", value: handoff.execution.verificationOperations }
    ]
  };
  const result = normalizedTaskSpecSchema.safeParse(normalized);
  if (!result.success) throw new HandoffValidationError(zodIssues(result.error));
  return result.data;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sortJson(item)]));
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

export function hashTaskSpec(spec: NormalizedTaskSpec): string {
  return createHash("sha256").update(canonicalJson(spec), "utf8").digest("hex");
}

function zodIssues(error: z.ZodError): ValidationIssue[] {
  return error.issues.map(issue => ({
    path: issue.path.length ? issue.path.join(".") : "handoff",
    message: issue.message
  }));
}

function parseYaml(text: string): unknown {
  const document = parseDocument(text, {
    schema: "core",
    customTags: [],
    merge: false,
    uniqueKeys: true,
    prettyErrors: true
  });
  const diagnostics = [...document.errors, ...document.warnings];
  if (diagnostics.length) {
    throw new HandoffValidationError(diagnostics.map(error => ({ path: "yaml", message: error.message.split("\n")[0] ?? "Invalid YAML." })));
  }
  try {
    return document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    throw new HandoffValidationError([{ path: "yaml", message: error instanceof Error ? error.message : "Invalid YAML." }]);
  }
}

export function parseHandoffText(input: string, requestedFormat?: "AUTO" | HandoffFormat): { format: HandoffFormat; handoff: RelayHandoffV1; normalized: NormalizedTaskSpec; specHash: string } {
  const size = Buffer.byteLength(input, "utf8");
  if (size > MAX_HANDOFF_BYTES) throw new HandoffValidationError([{ path: "handoff", message: `Payload exceeds the ${MAX_HANDOFF_BYTES}-byte limit.` }]);
  const text = input.trim();
  if (!text) throw new HandoffValidationError([{ path: "handoff", message: "Handoff text is required." }]);

  const format: HandoffFormat = requestedFormat && requestedFormat !== "AUTO"
    ? requestedFormat
    : text.startsWith("{") || text.startsWith("[") ? "JSON" : "YAML";
  let raw: unknown;
  if (format === "JSON") {
    try {
      raw = JSON.parse(text) as unknown;
    } catch (error) {
      throw new HandoffValidationError([{ path: "json", message: error instanceof Error ? error.message : "Malformed JSON." }]);
    }
  } else {
    raw = parseYaml(text);
  }

  const result = relayHandoffV1Schema.safeParse(raw);
  if (!result.success) throw new HandoffValidationError(zodIssues(result.error));
  const normalized = normalizeHandoff(result.data);
  return { format, handoff: result.data, normalized, specHash: hashTaskSpec(normalized) };
}

export const RELAY_HANDOFF_V1_TEMPLATE = `version: 1
project:
  name: MyProject
  pathHint: C:\\work\\my-project
task:
  title: Describe the requested change
  objective: Explain the concrete outcome Relay should produce.
  taskType: implementation
  complexity: normal
  context: Add only the context needed to understand the task.
constraints:
  - Do not modify production
acceptanceCriteria:
  - The requested behavior is implemented
  - Relevant tests pass
execution:
  executor: codex
  model: auto
  effort: auto
  reviewer: claude
  requireApproval: true
  allowSourceTransmissionToApi: false
  workspaceWrite: true
  nonProductionConfirmed: true
  allowDirtyWorkspace: false
  timeoutSeconds: 1800
  verificationOperations:
    - NPM_TEST
`;
