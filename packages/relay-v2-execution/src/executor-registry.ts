import type { ExecutorSelection } from "@project-relay/relay-v2-domain";
import type { RelayExecutor } from "./executor-contract.js";

const executorIdBySelection: Partial<Record<ExecutorSelection, string>> = {
  FAKE: "fake",
  CODEX: "codex-cli"
};

export class ExecutorRegistry {
  private readonly executors: Map<string, RelayExecutor>;

  constructor(executors: readonly RelayExecutor[]) {
    this.executors = new Map(executors.map(executor => [executor.id, executor]));
    if (this.executors.size !== executors.length) throw new Error("Executor IDs must be unique.");
    for (const executor of executors) executor.describe();
  }

  get(id: string): RelayExecutor | undefined { return this.executors.get(id); }
  require(id: string): RelayExecutor {
    const executor = this.get(id);
    if (!executor) throw new Error(`Executor '${id}' is not registered.`);
    return executor;
  }
  forApprovedSelection(selection: ExecutorSelection): RelayExecutor | undefined {
    const id = executorIdBySelection[selection];
    return id ? this.get(id) : undefined;
  }
  list(): RelayExecutor[] { return [...this.executors.values()]; }
}
