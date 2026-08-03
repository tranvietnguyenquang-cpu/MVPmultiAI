import { randomUUID } from "node:crypto";
import { redactSecrets } from "@project-relay/local-safety";
import { ReviewEngine } from "./review-engine.js";

export type ReviewRuntimeDiagnostic = {
  level: "ERROR";
  code: "REVIEW_RUNTIME_TICK_FAILED";
  message: string;
  reviewRequestId?: string;
  createdAt: string;
};

export type ReviewRuntimeOptions = {
  ownerId?: string;
  pollMs?: number;
  recoveryEvery?: number;
  onDiagnostic?: (diagnostic: ReviewRuntimeDiagnostic) => void;
};

/**
 * Durable review runtime: polls for PENDING ReviewRequest rows, atomically
 * claims one at a time via ReviewEngine.claimNext, and runs it. API request
 * handlers never invoke a reviewer directly — they only create PENDING rows,
 * so a crashed request or restarted process can never strand or silently
 * drop a review. Multiple ReviewRuntimeHost instances (each with a distinct
 * ownerId) may safely share one database; the claim CAS guarantees only one
 * ever owns a given review.
 */
export class ReviewRuntimeHost {
  readonly ownerId: string;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private stopping = false;
  private ticks = 0;
  private active: Promise<void> | undefined;
  private activeReviewRequestId: string | undefined;
  private readonly pollMs: number;
  private readonly recoveryEvery: number;
  private readonly onDiagnostic: ((diagnostic: ReviewRuntimeDiagnostic) => void) | undefined;
  private readonly diagnosticHistory: ReviewRuntimeDiagnostic[] = [];

  constructor(readonly engine: ReviewEngine, options: ReviewRuntimeOptions = {}) {
    this.ownerId = options.ownerId ?? randomUUID();
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
        this.recordDiagnostic(error, this.activeReviewRequestId);
        this.schedule(this.pollMs);
      });
    }, delay);
  }

  private recordDiagnostic(error: unknown, reviewRequestId?: string): void {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const message = redactSecrets(rawMessage || "Unexpected review runtime host error.").slice(0, 1_000);
    const diagnostic: ReviewRuntimeDiagnostic = {
      level: "ERROR",
      code: "REVIEW_RUNTIME_TICK_FAILED",
      message,
      ...(reviewRequestId ? { reviewRequestId } : {}),
      createdAt: new Date().toISOString()
    };
    this.diagnosticHistory.push(diagnostic);
    if (this.diagnosticHistory.length > 50) this.diagnosticHistory.shift();
    try { this.onDiagnostic?.(diagnostic); } catch { /* diagnostics must not break the runtime */ }
  }

  async tick(): Promise<boolean> {
    if (this.active) return false;
    let ownedReviewRequestId: string | undefined;
    let nextDelay = this.pollMs;
    try {
      this.ticks += 1;
      if (this.ticks % this.recoveryEvery === 0) await this.engine.recoverStaleReviews();
      const claim = await this.engine.claimNext(this.ownerId);
      if (!claim) return false;
      ownedReviewRequestId = claim.reviewRequestId;
      this.activeReviewRequestId = claim.reviewRequestId;
      nextDelay = 0;
      this.active = this.engine.runClaimed(claim.reviewRequestId, claim.leaseToken);
      await this.active;
      return true;
    } catch (error) {
      this.recordDiagnostic(error, ownedReviewRequestId ?? this.activeReviewRequestId);
      return false;
    } finally {
      if (ownedReviewRequestId) {
        this.active = undefined;
        this.activeReviewRequestId = undefined;
      }
      this.schedule(nextDelay);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    if (this.activeReviewRequestId) await this.engine.cancelReview(this.activeReviewRequestId, "local-review-runtime-stop");
    await this.active?.catch(() => undefined);
  }

  diagnostics(): readonly ReviewRuntimeDiagnostic[] { return [...this.diagnosticHistory]; }

  status() {
    return {
      running: this.running && !this.stopping,
      active: Boolean(this.active),
      ownerId: this.ownerId,
      lastDiagnostic: this.diagnosticHistory.at(-1) ?? null
    };
  }
}
