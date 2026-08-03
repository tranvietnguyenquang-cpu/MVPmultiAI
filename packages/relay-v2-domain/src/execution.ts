import { z } from "zod";

export const executionStatusSchema = z.enum([
  "QUEUED", "WAITING_FOR_WORKSPACE", "CLAIMED", "PREPARING", "RUNNING",
  "CANCELLATION_REQUESTED", "SUCCEEDED", "FAILED", "TIMED_OUT", "CANCELLED", "BLOCKED"
]);
export type ExecutionStatus = z.infer<typeof executionStatusSchema>;

export const TERMINAL_EXECUTION_STATUSES = Object.freeze([
  "SUCCEEDED", "FAILED", "TIMED_OUT", "CANCELLED", "BLOCKED"
] as const satisfies readonly ExecutionStatus[]);

export const EXECUTION_TRANSITIONS: Readonly<Record<ExecutionStatus, readonly ExecutionStatus[]>> = Object.freeze({
  QUEUED: ["WAITING_FOR_WORKSPACE", "CLAIMED", "CANCELLED", "BLOCKED"],
  WAITING_FOR_WORKSPACE: ["CLAIMED", "CANCELLED", "BLOCKED"],
  CLAIMED: ["PREPARING", "CANCELLATION_REQUESTED", "FAILED", "BLOCKED"],
  PREPARING: ["RUNNING", "CANCELLATION_REQUESTED", "FAILED", "TIMED_OUT", "BLOCKED"],
  RUNNING: ["CANCELLATION_REQUESTED", "SUCCEEDED", "FAILED", "TIMED_OUT", "BLOCKED"],
  CANCELLATION_REQUESTED: ["CANCELLED", "TIMED_OUT", "BLOCKED"],
  SUCCEEDED: [], FAILED: [], TIMED_OUT: [], CANCELLED: [], BLOCKED: []
});

export class InvalidExecutionTransitionError extends Error {
  constructor(readonly from: ExecutionStatus, readonly to: ExecutionStatus) {
    super(`Execution session cannot transition from ${from} to ${to}.`);
    this.name = "InvalidExecutionTransitionError";
  }
}

export function isTerminalExecutionStatus(status: ExecutionStatus): boolean {
  return (TERMINAL_EXECUTION_STATUSES as readonly string[]).includes(status);
}

export function canTransitionExecution(from: ExecutionStatus, to: ExecutionStatus): boolean {
  return EXECUTION_TRANSITIONS[from].includes(to);
}

export function assertExecutionTransition(from: ExecutionStatus, to: ExecutionStatus): void {
  if (!canTransitionExecution(from, to)) throw new InvalidExecutionTransitionError(from, to);
}

export const executionEventTypeSchema = z.enum([
  "EXECUTION_REQUESTED", "SESSION_QUEUED", "SESSION_CLAIMED", "WORKSPACE_WAITING",
  "WORKSPACE_LOCKED", "EXECUTOR_PREPARING", "EXECUTION_STARTED", "OUTPUT_RECEIVED",
  "WARNING_RECEIVED", "CANCELLATION_REQUESTED", "EXECUTION_SUCCEEDED", "EXECUTION_FAILED",
  "EXECUTION_TIMED_OUT", "EXECUTION_CANCELLED", "WORKSPACE_RELEASED", "STALE_SESSION_RECOVERED",
  "PROCESS_STARTED", "GIT_BASELINE_CAPTURED", "GIT_EVIDENCE_CAPTURED", "VERIFICATION_STARTED",
  "VERIFICATION_COMPLETED"
]);
export type ExecutionEventType = z.infer<typeof executionEventTypeSchema>;

export const executionEventLevelSchema = z.enum(["DEBUG", "INFO", "WARNING", "ERROR"]);
export type ExecutionEventLevel = z.infer<typeof executionEventLevelSchema>;

export const executorEventSchema = z.object({
  type: z.enum(["process", "output", "warning", "result"]),
  message: z.string().max(1_000_000),
  payload: z.record(z.unknown()).default({})
}).strict();
export type ExecutorEvent = z.infer<typeof executorEventSchema>;

export const executionOutcomeSchema = z.object({
  status: z.enum(["succeeded", "failed", "timed_out", "cancelled", "blocked"]),
  summary: z.string().max(20_000),
  failureCode: z.string().max(100).optional(),
  failureMessage: z.string().max(4_000).optional()
}).strict();
export type ExecutionOutcome = z.infer<typeof executionOutcomeSchema>;

export const executorDescriptorSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{1,49}$/),
  displayName: z.string().min(1).max(100),
  capabilities: z.array(z.string().min(1).max(100)),
  supportedModes: z.array(z.string().min(1).max(100)),
  supportsCancellation: z.boolean(),
  supportsTimeout: z.boolean(),
  writeCapability: z.boolean(),
  providerType: z.enum(["FAKE", "LOCAL_CLI", "API"])
}).strict();
export type ExecutorDescriptor = z.infer<typeof executorDescriptorSchema>;

export const fakeExecutorScenarioSchema = z.object({
  outcome: z.enum(["success", "failure", "timeout", "cancellation"]).default("success"),
  eventCount: z.number().int().min(0).max(100).default(3),
  delayMs: z.number().int().min(0).max(10_000).default(0),
  warningAt: z.array(z.number().int().min(0).max(99)).default([]),
  changedFiles: z.array(z.string().min(1).max(500)).max(100).default([]),
  summary: z.string().min(1).max(4_000).default("Fake execution completed successfully.")
}).strict();
export type FakeExecutorScenario = z.infer<typeof fakeExecutorScenarioSchema>;
