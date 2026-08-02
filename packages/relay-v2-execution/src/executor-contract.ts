import type {
  ExecutionOutcome, ExecutorDescriptor, ExecutorEvent, FakeExecutorScenario
} from "@project-relay/relay-v2-domain";

export type ExecutorValidationRequest = {
  sessionId: string;
  workspacePath: string;
  approvedExecutor: string;
  approvedModel: string;
  approvedEffort: string;
};

export type ExecutorValidationResult = { valid: true } | { valid: false; reason: string };

export type ExecutionContext = ExecutorValidationRequest & {
  taskId: string;
  projectId: string;
  title: string;
  objective: string;
  scenario?: FakeExecutorScenario;
};

export type PreparedExecution = {
  executionId: string;
  context: ExecutionContext;
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
