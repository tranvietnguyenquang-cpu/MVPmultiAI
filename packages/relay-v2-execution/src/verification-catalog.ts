import { access, realpath } from "node:fs/promises";
import path from "node:path";
import { verificationOperationSchema, type VerificationOperation } from "@project-relay/relay-v2-domain";
import { SafeProcessRunner, type ProcessRunner, type ProcessRunnerEvent } from "./process-runner.js";

export type VerificationResult = {
  operation: VerificationOperation;
  displayCommand: string;
  passed: boolean;
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  summary: string;
};

const definitions: Record<VerificationOperation, { displayCommand: string; npmArgs: string[] }> = {
  NPM_TEST: { displayCommand: "npm test", npmArgs: ["test"] },
  NPM_TYPECHECK: { displayCommand: "npm run typecheck", npmArgs: ["run", "typecheck"] },
  NPM_BUILD: { displayCommand: "npm run build", npmArgs: ["run", "build"] }
};

export class VerificationCatalogRunner {
  constructor(
    private readonly runner: ProcessRunner = new SafeProcessRunner(),
    private readonly npmCliPath?: string,
    private readonly environment: NodeJS.ProcessEnv = process.env
  ) {}

  private async resolveNpmCli(): Promise<string | undefined> {
    const candidates = [
      this.npmCliPath,
      this.environment.npm_execpath,
      path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")
    ].filter((candidate): candidate is string => Boolean(candidate));
    for (const candidate of candidates) {
      try { await access(candidate); return await realpath(candidate); } catch {}
    }
    return undefined;
  }

  async run(input: {
    sessionId: string;
    workspacePath: string;
    operations: VerificationOperation[];
    timeoutMs: number;
    signal: AbortSignal;
    onEvent?: (operation: VerificationOperation, event: ProcessRunnerEvent) => Promise<void> | void;
  }): Promise<VerificationResult[]> {
    const operations = input.operations.map(operation => verificationOperationSchema.parse(operation));
    if (!operations.length) return [];
    const npmCli = await this.resolveNpmCli();
    if (!npmCli) return operations.map(operation => ({
      operation, displayCommand: definitions[operation].displayCommand, passed: false, exitCode: null,
      timedOut: false, cancelled: false, summary: "The server-owned npm CLI entry point was not found."
    }));
    const results: VerificationResult[] = [];
    for (const operation of operations) {
      const definition = definitions[operation];
      let exitCode: number | null = null;
      let timedOut = false;
      let cancelled = false;
      for await (const event of this.runner.run({
        executionId: `${input.sessionId}-verify-${operation.toLowerCase()}`,
        executablePath: process.execPath,
        args: [npmCli, ...definition.npmArgs],
        cwd: input.workspacePath,
        timeoutMs: input.timeoutMs,
        maxOutputBytes: 2 * 1024 * 1024,
        environment: this.environment
      }, input.signal)) {
        await input.onEvent?.(operation, event);
        if (event.type === "exit") {
          exitCode = event.result.exitCode;
          timedOut = event.result.timedOut;
          cancelled = event.result.cancelled;
        }
      }
      const passed = exitCode === 0 && !timedOut && !cancelled;
      results.push({
        operation, displayCommand: definition.displayCommand, passed, exitCode, timedOut, cancelled,
        summary: passed ? `${definition.displayCommand} passed.` : `${definition.displayCommand} failed with exit code ${exitCode ?? "unknown"}.`
      });
      if (!passed) break;
    }
    return results;
  }
}
