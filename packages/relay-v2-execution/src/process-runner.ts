import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { redactSecrets } from "@project-relay/local-safety";
import { buildSafeEnvironment } from "./environment-policy.js";

export type ProcessOwnership = {
  executionId: string;
  pid: number;
  processIdentity: string;
  startedAt: string;
};

export type ProcessResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  cancelled: boolean;
  outputTruncated: boolean;
  stdoutBytes: number;
  stderrBytes: number;
};

export type ProcessRunnerEvent =
  | { type: "started"; ownership: ProcessOwnership }
  /**
   * `rawByteCount` is the size of the ORIGINAL chunk this message was decoded
   * and redacted from. It is what lets a consumer close the accounting between
   * "bytes the process wrote" (ProcessResult.stdoutBytes/stderrBytes) and
   * "bytes this consumer actually received", and therefore tell redaction
   * apart from output the runner discarded at the cap. Optional only so a
   * lightweight test double need not synthesize it -- a consumer that does not
   * receive it must treat any reported output loss as UNATTRIBUTED rather than
   * assuming its own stream was unaffected.
   */
  | { type: "stdout" | "stderr"; message: string; rawByteCount?: number }
  | { type: "warning"; message: string }
  | { type: "exit"; result: ProcessResult };

export type ProcessRunRequest = {
  executionId: string;
  executablePath: string;
  args: readonly string[];
  cwd: string;
  stdin?: string;
  environment?: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes?: number;
};

export interface OwnedProcessTerminator {
  terminate(child: ChildProcessWithoutNullStreams, ownership: ProcessOwnership, environment: NodeJS.ProcessEnv): Promise<void>;
}

export interface ProcessRunner {
  run(request: ProcessRunRequest, signal?: AbortSignal): AsyncIterable<ProcessRunnerEvent>;
  cancel(executionId: string): Promise<boolean>;
  owns(executionId: string, ownership: ProcessOwnership): boolean;
}

export type ProcessRunnerStage = "before-validation" | "after-validation" | "before-spawn" | "after-spawn";

export type ProcessRunnerHooks = {
  /** Deterministic lifecycle observation used by race tests and lightweight diagnostics. */
  onStage?(stage: ProcessRunnerStage): void | Promise<void>;
  validateRequest?(request: ProcessRunRequest): Promise<{ executablePath: string; cwd: string }>;
};

export class DefaultOwnedProcessTerminator implements OwnedProcessTerminator {
  async terminate(child: ChildProcessWithoutNullStreams, ownership: ProcessOwnership, environment: NodeJS.ProcessEnv): Promise<void> {
    if (child.exitCode !== null || child.pid !== ownership.pid) return;
    if (process.platform !== "win32") {
      child.kill("SIGTERM");
      return;
    }
    const systemRoot = environment.SystemRoot ?? environment.SYSTEMROOT ?? environment.WINDIR ?? "C:\\Windows";
    const taskkill = path.join(systemRoot, "System32", "taskkill.exe");
    await new Promise<void>(resolve => {
      const killer = spawn(taskkill, ["/PID", String(ownership.pid), "/T", "/F"], {
        cwd: path.dirname(taskkill), env: buildSafeEnvironment(environment), shell: false, windowsHide: true, stdio: "ignore"
      });
      killer.once("error", () => resolve());
      killer.once("exit", () => resolve());
    });
  }
}

class AsyncEventQueue<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(value: T | undefined) => void> = [];
  private ended = false;

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(value);
    else this.values.push(value);
  }

  end(): void {
    this.ended = true;
    while (this.waiters.length) this.waiters.shift()?.(undefined);
  }

  async next(): Promise<T | undefined> {
    const value = this.values.shift();
    if (value !== undefined) return value;
    if (this.ended) return undefined;
    return new Promise(resolve => this.waiters.push(resolve));
  }
}

type OwnedEntry = {
  child: ChildProcessWithoutNullStreams;
  ownership: ProcessOwnership;
  environment: NodeJS.ProcessEnv;
  terminating?: Promise<void>;
  terminationReason?: "cancelled" | "timed-out";
};

export class SafeProcessRunner implements ProcessRunner {
  private readonly owned = new Map<string, OwnedEntry>();

  constructor(
    private readonly terminator: OwnedProcessTerminator = new DefaultOwnedProcessTerminator(),
    private readonly hooks: ProcessRunnerHooks = {}
  ) {}

  private async validateRequest(request: ProcessRunRequest): Promise<{ executablePath: string; cwd: string }> {
    if (!path.isAbsolute(request.executablePath)) throw new Error("Process executable must be an absolute path.");
    const executablePath = await realpath(request.executablePath);
    if (!(await stat(executablePath)).isFile()) throw new Error("Process executable must be a file.");
    const cwd = await realpath(request.cwd);
    if (!(await stat(cwd)).isDirectory()) throw new Error("Process working directory must be a directory.");
    if (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 7_200_000) throw new Error("Process timeout is outside the allowed range.");
    return { executablePath, cwd };
  }

  private async terminate(entry: OwnedEntry): Promise<void> {
    entry.terminating ??= this.terminator.terminate(entry.child, entry.ownership, entry.environment);
    await entry.terminating;
  }

  private requestTermination(entry: OwnedEntry, reason: "cancelled" | "timed-out", report: (message: string) => void): Promise<void> {
    entry.terminationReason ??= reason;
    return this.terminate(entry).catch(error => {
      report(redactSecrets(`Owned process termination failed; Relay will retain ownership until process exit: ${error instanceof Error ? error.message : String(error)}`));
    });
  }

  async cancel(executionId: string): Promise<boolean> {
    const entry = this.owned.get(executionId);
    if (!entry) return false;
    await this.requestTermination(entry, "cancelled", () => undefined);
    return true;
  }

  owns(executionId: string, ownership: ProcessOwnership): boolean {
    const entry = this.owned.get(executionId);
    return Boolean(entry && entry.ownership.pid === ownership.pid && entry.ownership.processIdentity === ownership.processIdentity && entry.ownership.startedAt === ownership.startedAt);
  }

  async *run(request: ProcessRunRequest, signal?: AbortSignal): AsyncIterable<ProcessRunnerEvent> {
    if (this.owned.has(request.executionId)) throw new Error("This execution already owns a process.");
    const queue = new AsyncEventQueue<ProcessRunnerEvent>();
    let entry: OwnedEntry | undefined;
    let abortRequested = signal?.aborted ?? false;
    const reportTerminationFailure = (message: string): void => queue.push({ type: "warning", message });
    const abort = (): void => {
      abortRequested = true;
      if (entry) void this.requestTermination(entry, "cancelled", reportTerminationFailure);
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      if (abortRequested) {
        yield { type: "exit", result: { exitCode: null, signal: null, timedOut: false, cancelled: true, outputTruncated: false, stdoutBytes: 0, stderrBytes: 0 } };
        return;
      }
      await this.hooks.onStage?.("before-validation");
      if (abortRequested) {
        yield { type: "exit", result: { exitCode: null, signal: null, timedOut: false, cancelled: true, outputTruncated: false, stdoutBytes: 0, stderrBytes: 0 } };
        return;
      }
      const validated = await (this.hooks.validateRequest?.(request) ?? this.validateRequest(request));
      await this.hooks.onStage?.("after-validation");
      if (abortRequested) {
        yield { type: "exit", result: { exitCode: null, signal: null, timedOut: false, cancelled: true, outputTruncated: false, stdoutBytes: 0, stderrBytes: 0 } };
        return;
      }
      await this.hooks.onStage?.("before-spawn");
      if (abortRequested) {
        yield { type: "exit", result: { exitCode: null, signal: null, timedOut: false, cancelled: true, outputTruncated: false, stdoutBytes: 0, stderrBytes: 0 } };
        return;
      }
      const environment = buildSafeEnvironment(request.environment ?? process.env);
      const child = spawn(validated.executablePath, [...request.args], {
        cwd: validated.cwd, env: environment, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"]
      });
    const startedAt = new Date().toISOString();
    const maxOutputBytes = request.maxOutputBytes ?? 5 * 1024 * 1024;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputTruncated = false;
    let startError: Error | undefined;
    let settled = false;
    const ownership: ProcessOwnership = {
      executionId: request.executionId,
      pid: child.pid ?? 0,
      processIdentity: randomUUID(),
      startedAt
    };
    entry = { child, ownership, environment };
    this.owned.set(request.executionId, entry);

    const observe = (type: "stdout" | "stderr", chunk: Buffer): void => {
      if (type === "stdout") stdoutBytes += chunk.byteLength;
      else stderrBytes += chunk.byteLength;
      const total = stdoutBytes + stderrBytes;
      if (total > maxOutputBytes) {
        if (!outputTruncated) queue.push({ type: "warning", message: "Process output exceeded the Relay preview limit; the bounded artifact is truncated." });
        outputTruncated = true;
        return;
      }
      queue.push({ type, message: redactSecrets(chunk.toString("utf8")), rawByteCount: chunk.byteLength });
    };
    child.stdout.on("data", (chunk: Buffer) => observe("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => observe("stderr", chunk));
    const finish = (exitCode: number | null, processSignal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      if (startError) queue.push({ type: "warning", message: redactSecrets(`Process failed to start: ${startError.message}`) });
      queue.push({ type: "exit", result: {
        exitCode, signal: processSignal, timedOut: entry?.terminationReason === "timed-out",
        cancelled: entry?.terminationReason === "cancelled", outputTruncated, stdoutBytes, stderrBytes
      } });
      queue.end();
    };
    child.once("error", error => { startError = error; finish(null, null); });
    child.once("exit", finish);

    await this.hooks.onStage?.("after-spawn");
    if (abortRequested) await this.requestTermination(entry, "cancelled", reportTerminationFailure);
    const timeout = setTimeout(() => {
      if (entry) void this.requestTermination(entry, "timed-out", reportTerminationFailure);
    }, request.timeoutMs);
    if (request.stdin !== undefined) child.stdin.end(request.stdin);
    else child.stdin.end();

    try {
      if (!child.pid) queue.push({ type: "warning", message: "Process ownership PID was unavailable at start." });
      else if (!abortRequested) yield { type: "started", ownership };
      while (true) {
        const event = await queue.next();
        if (!event) break;
        yield event;
      }
    } finally {
      clearTimeout(timeout);
      this.owned.delete(request.executionId);
      child.stdout.destroy();
      child.stderr.destroy();
      child.stdin.destroy();
    }
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }
}
