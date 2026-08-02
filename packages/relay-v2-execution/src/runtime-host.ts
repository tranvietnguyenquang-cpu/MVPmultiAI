import { ExecutionEngine } from "./engine.js";
import { redactSecrets } from "@project-relay/local-safety";

export type RuntimeDiagnostic = {
  level: "ERROR";
  code: "RUNTIME_TICK_FAILED";
  message: string;
  sessionId?: string;
  createdAt: string;
};

export type ExecutionRuntimeOptions = {
  pollMs?: number;
  recoveryEvery?: number;
  onDiagnostic?: (diagnostic: RuntimeDiagnostic) => void;
};

export class ExecutionRuntimeHost {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private stopping = false;
  private ticks = 0;
  private active: Promise<void> | undefined;
  private activeSessionId: string | undefined;
  private readonly pollMs: number;
  private readonly recoveryEvery: number;
  private readonly onDiagnostic: ((diagnostic: RuntimeDiagnostic) => void) | undefined;
  private readonly diagnosticHistory: RuntimeDiagnostic[] = [];

  constructor(readonly engine: ExecutionEngine, options: ExecutionRuntimeOptions = {}) {
    this.pollMs = options.pollMs ?? 100;
    this.recoveryEvery = options.recoveryEvery ?? 20;
    this.onDiagnostic = options.onDiagnostic;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    this.schedule(0);
  }

  private schedule(delay: number): void {
    if (!this.running || this.stopping) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick().catch(error => {
        // tick() contains its own boundary; this guard prevents future changes
        // from turning a scheduled invocation into an unhandled rejection.
        this.recordDiagnostic(error, this.activeSessionId);
        this.schedule(this.pollMs);
      });
    }, delay);
  }

  private recordDiagnostic(error: unknown, sessionId?: string): void {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const message = redactSecrets(rawMessage || "Unexpected runtime host error.").slice(0, 1_000);
    const diagnostic: RuntimeDiagnostic = {
      level: "ERROR",
      code: "RUNTIME_TICK_FAILED",
      message,
      ...(sessionId ? { sessionId } : {}),
      createdAt: new Date().toISOString()
    };
    this.diagnosticHistory.push(diagnostic);
    if (this.diagnosticHistory.length > 50) this.diagnosticHistory.shift();
    try { this.onDiagnostic?.(diagnostic); } catch { /* diagnostics must not break the runtime */ }
  }

  async tick(): Promise<boolean> {
    if (this.active) return false;
    let ownedSessionId: string | undefined;
    let nextDelay = this.pollMs;
    try {
      this.ticks += 1;
      if (this.ticks % this.recoveryEvery === 0) await this.engine.recoverStaleSessions();
      const claim = await this.engine.claimNext();
      if (!claim) return false;
      ownedSessionId = claim.sessionId;
      this.activeSessionId = claim.sessionId;
      nextDelay = 0;
      this.active = this.engine.runClaimed(claim.sessionId, claim.leaseToken);
      await this.active;
      return true;
    } catch (error) {
      this.recordDiagnostic(error, ownedSessionId ?? this.activeSessionId);
      return false;
    } finally {
      if (ownedSessionId) {
        this.active = undefined;
        this.activeSessionId = undefined;
      }
      this.schedule(nextDelay);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    if (this.activeSessionId) await this.engine.cancelSession(this.activeSessionId, "local-runtime-stop");
    await this.active?.catch(() => undefined);
  }

  diagnostics(): readonly RuntimeDiagnostic[] { return [...this.diagnosticHistory]; }

  status() {
    return {
      running: this.running && !this.stopping,
      active: Boolean(this.active),
      executor: this.engine.executor.describe(),
      lastDiagnostic: this.diagnosticHistory.at(-1) ?? null
    };
  }
}
