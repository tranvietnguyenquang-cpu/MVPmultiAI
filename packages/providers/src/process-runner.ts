import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import crossSpawn from "cross-spawn";
import { SAFE_ENVIRONMENT, StreamSafeRedactor, validateWorkspace } from "@project-relay/execution";
import type { TaskCapsuleContent } from "@project-relay/shared";
import {
  CliExecutableResolutionError,
  classifyExecutableLaunchError,
  resolveCliExecutable,
  type ExecutableFailureCode,
  type ResolvedExecutable,
} from "./executable.js";
import type {
  AgentEvent,
  AgentSession,
  AgentSessionInput,
  CodingProvider,
  ConnectionTest,
  ExecutionCapability,
  ProviderAuthentication,
  ProviderId,
  ProviderProbe,
  ProviderProcessStart,
  ProviderRole,
} from "./types.js";
import {
  IncrementalLineReader,
  StaleProviderSessionError,
  StructuredStreamAccumulator,
  isStaleProviderSessionSignal,
  type ReaderLine,
  type StructuredStreamParser,
  type UsageReport,
} from "./stream-parser.js";

export type SpawnFn = typeof crossSpawn;
export type Resolver = (command: "codex" | "claude") => Promise<ResolvedExecutable | undefined>;
export type ProcessResult = {
  code: number | null;
  output: string;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
  error?: string;
};

type SessionRecord = {
  events: AgentEvent[];
  waiters: Array<() => void>;
  controller: AbortController;
  usage: UsageReport;
  child?: ChildProcess;
  complete: boolean;
};

export function classifyProviderProbe(
  output: string,
  code: number | null,
  marker: string,
  result: Pick<ProcessResult, "timedOut" | "cancelled" | "error">,
): ProviderAuthentication {
  const text = output.toLowerCase();
  if (result.cancelled || result.timedOut) return "UNKNOWN";
  if (/rate.?limit|too many requests|429/.test(text)) return "RATE_LIMITED";
  if (/network|enotfound|econnrefused|timed out|offline/.test(text)) return "NETWORK_ERROR";
  if (code === 0 && output.includes(marker)) return "AUTHENTICATED";
  if (/not (logged|authenticated)|login|auth(?:entication)? required|unauthorized|forbidden|401/.test(text)) {
    return "NOT_AUTHENTICATED";
  }
  return result.error || code !== 0 ? "CLI_ERROR" : "UNKNOWN";
}

function resetAtFrom(output: string): Date | undefined {
  for (const line of output.split("\n")) {
    try {
      const value = JSON.parse(line) as { reset_at?: string; resetAt?: string };
      const raw = value.reset_at ?? value.resetAt;
      if (raw) {
        const date = new Date(raw);
        if (!Number.isNaN(date.valueOf())) return date;
      }
    } catch {
      // Provider output is untrusted; non-JSON lines cannot carry reset metadata.
    }
  }
  return undefined;
}

function killProcessTree(child: ChildProcess): void {
  if (process.platform === "win32" && child.pid) {
    const killer = nodeSpawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      shell: false,
      windowsHide: true,
      env: SAFE_ENVIRONMENT,
    });
    killer.unref();
    return;
  }
  child.kill();
}

export abstract class CliProvider implements CodingProvider {
  abstract readonly id: ProviderId;
  abstract readonly name: string;
  abstract readonly command: "codex" | "claude";
  abstract readonly defaultRoles: ProviderRole[];
  abstract readonly setupInstructions: string;

  protected readonly sessions = new Map<string, SessionRecord>();
  private resolved: ResolvedExecutable | undefined;
  private resolutionFailure: ExecutableFailureCode | undefined;

  constructor(
    protected readonly spawnProcess: SpawnFn = crossSpawn,
    private readonly resolver: Resolver = resolveCliExecutable,
  ) {}

  protected async resolve(): Promise<ResolvedExecutable | undefined> {
    if (!this.resolved) {
      try {
        this.resolved = await this.resolver(this.command);
        this.resolutionFailure = undefined;
      } catch (error) {
        if (error instanceof CliExecutableResolutionError) {
          this.resolutionFailure = error.code;
          return undefined;
        }
        throw error;
      }
    }
    return this.resolved;
  }

  private invalidateResolvedExecutable(error: unknown): void {
    const failure = classifyExecutableLaunchError(error);
    if (failure === "CLI_NOT_FOUND" || failure === "CLI_ACCESS_DENIED") {
      this.resolved = undefined;
      this.resolutionFailure = failure;
    }
  }

  protected async execute(
    args: string[],
    input?: string,
    signal?: AbortSignal,
    timeoutMs = 30_000,
    maxBytes = 32_768,
  ): Promise<ProcessResult> {
    const executable = await this.resolve();
    if (!executable) {
      return {
        code: null,
        output: "",
        durationMs: 0,
        timedOut: false,
        cancelled: false,
        error: this.resolutionFailure ?? "CLI_NOT_FOUND",
      };
    }

    const started = Date.now();
    const redactor = new StreamSafeRedactor(maxBytes);
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = this.spawnProcess(executable.canonicalPath, args, {
          shell: false,
          windowsHide: true,
          env: SAFE_ENVIRONMENT,
        });
      } catch (error) {
        this.invalidateResolvedExecutable(error);
        resolve({
          code: null,
          output: "",
          durationMs: Date.now() - started,
          timedOut: false,
          cancelled: false,
          error: classifyExecutableLaunchError(error),
        });
        return;
      }

      let timedOut = false;
      let cancelled = false;
      let error: string | undefined;
      child.stdout?.on("data", (chunk: Buffer) => redactor.append(chunk));
      child.stderr?.on("data", (chunk: Buffer) => redactor.append(chunk));
      child.once("error", (event) => {
        this.invalidateResolvedExecutable(event);
        error = classifyExecutableLaunchError(event);
      });
      const stop = () => {
        cancelled = true;
        killProcessTree(child);
      };
      signal?.addEventListener("abort", stop, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        killProcessTree(child);
      }, timeoutMs);
      child.once("close", (code) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", stop);
        resolve({
          code,
          output: redactor.flush(),
          durationMs: Date.now() - started,
          timedOut,
          cancelled,
          ...(error ? { error } : {}),
        });
      });
      child.stdin?.end(input);
    });
  }

  async detectInstallation(): Promise<boolean> {
    return Boolean(await this.resolve());
  }

  async getVersion(): Promise<string | undefined> {
    const result = await this.execute(["--version"], undefined, undefined, 10_000);
    return result.code === 0 ? result.output.trim() : undefined;
  }

  async refreshHealth(): Promise<ProviderProbe> {
    const checkedAt = new Date();
    const installed = await this.detectInstallation();
    const version = installed ? await this.getVersion() : undefined;
    return {
      providerId: this.id,
      installed,
      ...(version ? { version } : {}),
      authentication: "UNKNOWN",
      available: installed,
      checkedAt,
      quotaSource: "CLI_STATUS",
      quotaConfidence: "LOW",
      quotaExact: false,
    };
  }

  protected abstract authCommand(): { args: string[]; prompt: string; marker: string };

  async probeAuthentication(signal?: AbortSignal): Promise<ProviderProbe> {
    const checkedAt = new Date();
    const command = this.authCommand();
    const result = await this.execute(command.args, command.prompt, signal, 60_000, 16_384);
    const authentication = classifyProviderProbe(result.output, result.code, command.marker, result);
    const installed = await this.detectInstallation();
    const resetAt = resetAtFrom(result.output);
    return {
      providerId: this.id,
      installed,
      authentication,
      available: authentication === "AUTHENTICATED",
      ...(result.durationMs ? { latencyMs: result.durationMs } : {}),
      checkedAt,
      markerObserved: result.output.includes(command.marker),
      exitCode: result.code,
      ...(resetAt ? { resetAt } : {}),
      quotaSource: "CLI_STATUS",
      quotaConfidence: "LOW",
      quotaExact: false,
    };
  }

  async testConnection(signal?: AbortSignal): Promise<ConnectionTest> {
    const probe = await this.probeAuthentication(signal);
    return {
      ok: probe.authentication === "AUTHENTICATED",
      output: "Provider probe completed; inspect persisted health status for details.",
      durationMs: probe.latencyMs ?? 0,
      markerObserved: probe.markerObserved === true,
      exitCode: probe.exitCode ?? null,
      probe,
    };
  }

  protected supportsCapability(_capability: ExecutionCapability): boolean {
    return true;
  }

  async createSession(input: AgentSessionInput): Promise<AgentSession> {
    if (!this.supportsCapability(input.capability)) {
      throw new Error(`${this.name} does not support ${input.capability} execution.`);
    }
    const workspace = await validateWorkspace(input.workspace);
    const session: AgentSession = {
      id: randomUUID(),
      providerId: this.id,
      workspace,
      taskId: input.taskId,
      role: input.role ?? this.defaultRoles[0]!,
      capability: input.capability,
      ...(input.resumeExternalId ? { externalId: input.resumeExternalId } : {}),
      ...(input.processLifecycle ? { processLifecycle: input.processLifecycle } : {}),
    };
    this.sessions.set(session.id, {
      events: [],
      waiters: [],
      controller: new AbortController(),
      usage: { estimated: true },
      complete: false,
    });
    return session;
  }

  protected prompt(session: AgentSession, capsule: TaskCapsuleContent): string {
    return [
      `Role: ${session.role}.`,
      "Use only supplied structured state and report evidence.",
      JSON.stringify(capsule, null, 2),
    ].join("\n\n");
  }

  protected abstract sessionCommand(session: AgentSession, resume: boolean): string[];
  protected abstract streamParser(): StructuredStreamParser;

  async startSession(session: AgentSession, capsule: TaskCapsuleContent, signal?: AbortSignal): Promise<void> {
    await this.runSession(session, capsule, false, signal);
  }

  async sendTask(session: AgentSession, capsule: TaskCapsuleContent, signal?: AbortSignal): Promise<void> {
    await this.startSession(session, capsule, signal);
  }

  async resumeSession(session: AgentSession, capsule: TaskCapsuleContent, signal?: AbortSignal): Promise<void> {
    await this.runSession(session, capsule, true, signal);
  }

  private async runSession(
    session: AgentSession,
    capsule: TaskCapsuleContent,
    resume: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    const record = this.sessions.get(session.id);
    if (!record) throw new Error("Unknown provider session.");

    const prompt = this.prompt(session, capsule);
    const executable = await this.resolve();
    if (!executable) throw new Error(`${this.name} CLI is not installed.`);

    record.usage = { estimated: true, inputTokens: Math.ceil(prompt.length / 4), outputTokens: 0 };
    const effective = signal ?? record.controller.signal;
    const reader = new IncrementalLineReader();
    const accumulator = new StructuredStreamAccumulator(this.streamParser());
    const pushEvent = (event: AgentEvent) => {
      record.events.push(event);
      record.waiters.splice(0).forEach((wake) => wake());
    };

    await new Promise<void>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = this.spawnProcess(executable.canonicalPath, this.sessionCommand(session, resume), {
          cwd: session.workspace,
          shell: false,
          windowsHide: true,
          env: SAFE_ENVIRONMENT,
        });
      } catch (error) {
        this.invalidateResolvedExecutable(error);
        reject(new Error(classifyExecutableLaunchError(error)));
        return;
      }
      record.child = child;
      const beginOutputProcessing = () => {
        const err = new StreamSafeRedactor(65_536);
        const consumeLine = (line: ReaderLine) => {
        for (const event of accumulator.consumeReaderLine(line)) {
          if (event.kind === "assistant" || event.kind === "assistant-final") {
            pushEvent({ type: "stdout", message: event.text, timestamp: new Date() });
          } else if (event.kind === "diagnostic") {
            pushEvent({ type: "stderr", message: event.message, timestamp: new Date() });
          } else if (event.kind === "usage") {
            pushEvent({ type: "usage", message: JSON.stringify(event.usage), timestamp: new Date() });
          }
        }
        };

        child.stdout?.on("data", (chunk: Buffer) => {
          for (const line of reader.push(chunk.toString("utf8"))) consumeLine(line);
        });
        child.stderr?.on("data", (chunk: Buffer) => err.append(chunk));
        const abort = () => killProcessTree(child);
        effective.addEventListener("abort", abort, { once: true });
        child.once("error", (error) => {
          this.invalidateResolvedExecutable(error);
          reject(error);
        });
        child.once("close", (code) => {
        effective.removeEventListener("abort", abort);
        for (const line of reader.end()) consumeLine(line);
        const stderrText = err.flush();
        if (stderrText) pushEvent({ type: "stderr", message: stderrText, timestamp: new Date() });

        const snapshot = accumulator.snapshot();
        if (snapshot.externalSessionId) session.externalId = snapshot.externalSessionId;
        if (snapshot.usage.inputTokens !== undefined || snapshot.usage.outputTokens !== undefined) {
          record.usage = snapshot.usage;
        } else {
          record.usage.outputTokens = (record.usage.outputTokens ?? 0) + Math.ceil(snapshot.assistantText.length / 4);
        }
        record.complete = true;
        record.waiters.splice(0).forEach((wake) => wake());

        const terminalFailed = snapshot.terminal?.status === "FAILED";
        if (code === 0 && !terminalFailed) {
          resolve();
          return;
        }

        const reason = snapshot.terminal?.reason ?? `${this.name} exited with code ${String(code)}.`;
        if (resume && isStaleProviderSessionSignal(snapshot.terminal?.reason, stderrText)) {
          reject(new StaleProviderSessionError(reason));
          return;
        }
        reject(new Error(reason));
        });
        child.stdin?.end(prompt);
      };

      const lifecycle = session.processLifecycle;
      if (!lifecycle) {
        beginOutputProcessing();
        return;
      }
      if (!child.pid) {
        void lifecycle.onProcessStartFailure({ pid: 0, error: new Error("Provider spawn did not report a PID.") })
          .finally(() => {
            record.complete = true;
            record.waiters.splice(0).forEach((wake) => wake());
            reject(new Error("PROVIDER_OWNERSHIP_FAILURE"));
          });
        return;
      }
      void (async () => {
        let start: ProviderProcessStart | undefined;
        try {
          start = await lifecycle.captureProcessStart(child.pid!);
          await lifecycle.onProcessStarted(start);
          beginOutputProcessing();
        } catch (error) {
          await lifecycle.onProcessStartFailure({ pid: child.pid!, ...(start ? { start } : {}), error }).catch(() => undefined);
          killProcessTree(child);
          record.complete = true;
          record.waiters.splice(0).forEach((wake) => wake());
          reject(new Error("PROVIDER_OWNERSHIP_FAILURE"));
        }
      })();
    });
  }

  async *streamEvents(sessionId: string): AsyncIterable<AgentEvent> {
    const record = this.sessions.get(sessionId);
    if (!record) throw new Error("Unknown provider session.");
    let cursor = 0;
    while (!record.complete || cursor < record.events.length) {
      while (cursor < record.events.length) yield record.events[cursor++]!;
      if (!record.complete) await new Promise<void>((resolve) => record.waiters.push(resolve));
    }
  }

  async cancelSession(sessionId: string): Promise<void> {
    const record = this.sessions.get(sessionId);
    if (!record) return;
    record.controller.abort();
    if (record.child) killProcessTree(record.child);
    record.complete = true;
    record.waiters.splice(0).forEach((wake) => wake());
  }

  async getUsage(sessionId: string): Promise<UsageReport> {
    return this.sessions.get(sessionId)?.usage ?? { estimated: true };
  }
}
