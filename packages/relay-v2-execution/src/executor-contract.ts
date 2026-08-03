import type {
  ExecutionOutcome, ExecutorDescriptor, ExecutorEvent, FakeExecutorScenario, TaskPermissionValue, VerificationOperation
} from "@project-relay/relay-v2-domain";
import type { ExecutionCapsule } from "./execution-capsule.js";

export type ExecutorValidationRequest = {
  sessionId: string;
  workspacePath: string;
  approvedExecutor: string;
  approvedModel: string;
  approvedEffort: string;
  approvedPermissions: TaskPermissionValue[];
  timeoutMs: number;
  verificationOperations: VerificationOperation[];
};

export type ExecutorValidationResult = { valid: true } | { valid: false; reason: string };

export type ExecutionContext = ExecutorValidationRequest & {
  taskId: string;
  projectId: string;
  title: string;
  objective: string;
  taskContext: string;
  constraints: string[];
  acceptanceCriteria: string[];
  approvedReviewer: string;
  capsule?: ExecutionCapsule;
  scenario?: FakeExecutorScenario;
};

export type PreparedExecution = {
  executionId: string;
  context: ExecutionContext;
  argv?: string[];
  executablePath?: string;
  stdin?: string;
};

export type ExecutionControls = {
  signal: AbortSignal;
  now(): Date;
  sleep(milliseconds: number): Promise<void>;
};

export type ExecutorHealth = {
  healthy: boolean;
  checkedAt: string;
  message: string;
};

export interface RelayExecutor {
  readonly id: string;
  describe(): ExecutorDescriptor;
  validate(request: ExecutorValidationRequest): Promise<ExecutorValidationResult>;
  prepare(context: ExecutionContext): Promise<PreparedExecution>;
  execute(prepared: PreparedExecution, controls: ExecutionControls): AsyncIterable<ExecutorEvent>;
  cancel?(executionId: string): Promise<void>;
  cleanup?(prepared: PreparedExecution, outcome: ExecutionOutcome): Promise<void>;
  health(): Promise<ExecutorHealth>;
}
