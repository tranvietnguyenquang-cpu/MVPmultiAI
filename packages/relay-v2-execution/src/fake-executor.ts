import {
  executorDescriptorSchema, executorEventSchema, fakeExecutorScenarioSchema,
  type ExecutorDescriptor, type ExecutorEvent, type FakeExecutorScenario
} from "@project-relay/relay-v2-domain";
import type {
  ExecutionContext, ExecutionControls, ExecutorHealth, ExecutorValidationRequest,
  ExecutorValidationResult, PreparedExecution, RelayExecutor
} from "./executor-contract.js";

export type FakeExecutorOptions = {
  scenario?: Partial<FakeExecutorScenario>;
  scenarioForContext?: (context: ExecutionContext) => Partial<FakeExecutorScenario> | undefined;
};

export class FakeExecutor implements RelayExecutor {
  readonly id = "fake";
  private readonly options: FakeExecutorOptions;
  private readonly cancelled = new Set<string>();

  constructor(options: FakeExecutorOptions = {}) { this.options = options; }

  describe(): ExecutorDescriptor {
    return executorDescriptorSchema.parse({
      id: this.id,
      displayName: "Fake Executor",
      capabilities: ["deterministic-events", "simulated-changed-files"],
      supportedModes: ["in-process-simulation"],
      supportsCancellation: true,
      supportsTimeout: true,
      writeCapability: false,
      providerType: "FAKE"
    });
  }

  async validate(request: ExecutorValidationRequest): Promise<ExecutorValidationResult> {
    return request.workspacePath ? { valid: true } : { valid: false, reason: "A workspace path is required." };
  }

  async prepare(context: ExecutionContext): Promise<PreparedExecution> {
    return { executionId: context.sessionId, context: { ...context, scenario: fakeExecutorScenarioSchema.parse({ ...this.options.scenario, ...this.options.scenarioForContext?.(context), ...context.scenario }) } };
  }

  async *execute(prepared: PreparedExecution, controls: ExecutionControls): AsyncIterable<ExecutorEvent> {
    const scenario = fakeExecutorScenarioSchema.parse(prepared.context.scenario);
    for (let index = 0; index < scenario.eventCount; index += 1) {
      if (this.cancelled.has(prepared.executionId) || controls.signal.aborted) throw controls.signal.reason ?? new DOMException("Cancelled", "AbortError");
      await controls.sleep(scenario.delayMs);
      const warning = scenario.warningAt.includes(index);
      yield executorEventSchema.parse({
        type: warning ? "warning" : "output",
        message: warning ? `Fake warning ${index + 1}` : `Fake output ${index + 1}`,
        payload: { index, changedFiles: index === scenario.eventCount - 1 ? scenario.changedFiles : [] }
      });
    }
    if (scenario.outcome === "failure") {
      yield executorEventSchema.parse({ type: "result", message: scenario.summary, payload: { success: false, failureCode: "FAKE_FAILURE" } });
      return;
    }
    if (scenario.outcome === "timeout" || scenario.outcome === "cancellation") {
      while (!controls.signal.aborted && !this.cancelled.has(prepared.executionId)) await controls.sleep(Math.max(1, scenario.delayMs || 5));
      throw controls.signal.reason ?? new DOMException("Cancelled", "AbortError");
    }
    yield executorEventSchema.parse({ type: "result", message: scenario.summary, payload: { success: true, changedFiles: scenario.changedFiles } });
  }

  async cancel(executionId: string): Promise<void> { this.cancelled.add(executionId); }
  async cleanup(): Promise<void> {}
  async health(): Promise<ExecutorHealth> { return { healthy: true, checkedAt: new Date().toISOString(), message: "In-process FakeExecutor is ready." }; }
}
