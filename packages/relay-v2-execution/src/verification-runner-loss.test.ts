import { describe, expect, it } from "vitest";
import { buildVerificationArtifact, verificationInnerTruncation } from "./evidence-envelopes.js";
import type { ProcessRunRequest, ProcessRunner, ProcessRunnerEvent, ProcessResult } from "./process-runner.js";
import { VerificationCatalogRunner } from "./verification-catalog.js";

/**
 * Runner-boundary output loss must never be recordable as a complete,
 * passing verification.
 *
 * SafeProcessRunner counts every byte a process writes but stops FORWARDING
 * once the combined output cap is reached. A consumer that reads only
 * `exitCode` from the exit event therefore persists: `outputTruncated: true`
 * at the runner boundary, nonzero raw byte counts, an EMPTY captured stream,
 * `captureTruncated: false`, and status PASSED -- an evidence record asserting
 * that a command which printed megabytes printed nothing. Every test here
 * pins one part of making that state unrepresentable.
 */

const exitResult = (overrides: Partial<ProcessResult> = {}): ProcessResult => ({
  exitCode: 0, signal: null, timedOut: false, cancelled: false,
  outputTruncated: false, stdoutBytes: 0, stderrBytes: 0, ...overrides
});

/** A runner that emits exactly the events a test scripts, so the loss shape under test is exact rather than incidental. */
class ScriptedRunner implements ProcessRunner {
  readonly requests: ProcessRunRequest[] = [];
  constructor(private readonly events: readonly ProcessRunnerEvent[]) {}
  owns(): boolean { return false; }
  async cancel(): Promise<boolean> { return false; }
  async *run(request: ProcessRunRequest): AsyncIterable<ProcessRunnerEvent> {
    this.requests.push(request);
    for (const event of this.events) yield event;
  }
}

async function runOnce(events: readonly ProcessRunnerEvent[]) {
  const runner = new VerificationCatalogRunner(new ScriptedRunner(events), process.execPath);
  const results = await runner.run({
    sessionId: "session", workspacePath: process.cwd(), operations: ["NPM_TEST"],
    timeoutMs: 1_000, signal: new AbortController().signal
  });
  return results[0]!;
}

describe("verification runner-level output loss", () => {
  it("records an exit-only run with discarded stdout as UNKNOWN loss, never as legitimate empty output", async () => {
    const result = await runOnce([{ type: "exit", result: exitResult({ outputTruncated: true, stdoutBytes: 4_096 }) }]);

    expect(result.runnerOutputTruncated).toBe(true);
    expect(result.runnerStdoutBytes).toBe(4_096);
    expect(result.stdoutCapture.captureCompleteness).toBe("TRUNCATED_UNKNOWN");
    expect(result.stdoutCapture.emptyOutputReason).toBe("LOST_UPSTREAM");
    expect(result.stdoutCapture.captureTruncated).toBe(true);
    // The complete stream no longer exists anywhere, so it is not hashed.
    expect(result.stdoutCapture.fullStreamContentHash).toBeNull();
    // The pre-existing provenance projection carries the same fact, which is
    // what makes the AUTHORITATIVE review path block on it.
    expect(result.stdoutProvenance.captureTruncated).toBe(true);
  });

  it("records an exit-only run with discarded stderr the same way", async () => {
    const result = await runOnce([{ type: "exit", result: exitResult({ outputTruncated: true, stderrBytes: 8_192 }) }]);

    expect(result.runnerStderrBytes).toBe(8_192);
    expect(result.stderrCapture.captureCompleteness).toBe("TRUNCATED_UNKNOWN");
    expect(result.stderrCapture.emptyOutputReason).toBe("LOST_UPSTREAM");
    expect(result.stderrProvenance.captureTruncated).toBe(true);
  });

  it("marks BOTH streams unknown when both lost output, with the lost amount known and the lost content not", async () => {
    const result = await runOnce([{ type: "exit", result: exitResult({ outputTruncated: true, stdoutBytes: 1_000, stderrBytes: 1_000 }) }]);

    expect(result.stdoutCapture.captureCompleteness).toBe("TRUNCATED_UNKNOWN");
    expect(result.stderrCapture.captureCompleteness).toBe("TRUNCATED_UNKNOWN");
    // Nothing was delivered on either stream, so HOW MUCH was lost is exact.
    // What it said is not, which is why completeness is UNKNOWN and no
    // complete-content hash is offered for either.
    expect(result.stdoutCapture.upstreamOmittedByteCount).toBe(1_000);
    expect(result.stderrCapture.upstreamOmittedByteCount).toBe(1_000);
    expect(result.stdoutCapture.fullStreamContentHash).toBeNull();
    expect(result.stderrCapture.fullStreamContentHash).toBeNull();
  });

  it("reports UNATTRIBUTED loss honestly when the runner does not report per-chunk raw sizes", async () => {
    // A process-runner implementation that forwards text without saying how
    // many raw bytes it came from leaves the split between "redacted" and
    // "discarded" genuinely unknowable. That is reported as unknown rather
    // than resolved in the evidence's favour.
    const result = await runOnce([
      { type: "stdout", message: "partial output" },
      { type: "exit", result: exitResult({ outputTruncated: true, stdoutBytes: 900_000 }) }
    ]);

    expect(result.stdoutCapture.deliveredByteCount).toBeNull();
    expect(result.stdoutCapture.upstreamOmittedByteCount).toBe(0);
    expect(result.stdoutCapture.captureCompleteness).toBe("TRUNCATED_UNKNOWN");
    expect(result.stdoutCapture.fullStreamContentHash).toBeNull();
    // stderr stays COMPLETE only because the runner's own counter proves the
    // process wrote zero bytes to it -- not because nothing was reported
    // about it. The aggregate flag is recorded either way.
    expect(result.runnerStderrBytes).toBe(0);
    expect(result.stderrCapture.captureCompleteness).toBe("COMPLETE");
    expect(result.runnerOutputTruncated).toBe(true);
  });

  it("attributes the loss exactly when the runner reports per-chunk raw sizes", async () => {
    const result = await runOnce([
      { type: "stdout", message: "kept", rawByteCount: 4 },
      { type: "exit", result: exitResult({ outputTruncated: true, stdoutBytes: 1_004, stderrBytes: 0 }) }
    ]);

    expect(result.stdoutCapture.upstreamOmittedByteCount).toBe(1_000);
    expect(result.stdoutCapture.deliveredByteCount).toBe(4);
    expect(result.stdoutCapture.captureCompleteness).toBe("TRUNCATED_UNKNOWN");
    // The stream that lost nothing is not tarred with the other's loss.
    expect(result.stderrCapture.captureCompleteness).toBe("COMPLETE");
  });

  it("keeps PASSED status while refusing to describe the run's output as complete", async () => {
    const result = await runOnce([{ type: "exit", result: exitResult({ exitCode: 0, outputTruncated: true, stdoutBytes: 2_048 }) }]);

    // The exit code is a fact and is recorded as one. What it may NOT do is
    // stand in for output that was never captured.
    expect(result.passed).toBe(true);
    expect(result.summary).toMatch(/output was lost/);
    expect(result.stdoutCapture.captureCompleteness).toBe("TRUNCATED_UNKNOWN");

    // ...and the artifact envelope built from it carries the loss upward, so
    // the artifact ROW is marked incomplete and the reviewer's producer-
    // truncation policy blocks the review.
    const artifact = buildVerificationArtifact([result]);
    expect(verificationInnerTruncation(artifact).captureTruncated).toBe(true);
  });

  it("records a genuinely silent, fully-captured run as COMPLETE and legitimately empty", async () => {
    const result = await runOnce([{ type: "exit", result: exitResult({ exitCode: 0 }) }]);

    expect(result.runnerOutputTruncated).toBe(false);
    expect(result.stdoutCapture.captureCompleteness).toBe("COMPLETE");
    expect(result.stdoutCapture.emptyOutputReason).toBe("LEGITIMATE_EMPTY");
    expect(result.stdoutCapture.fullStreamContentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(verificationInnerTruncation(buildVerificationArtifact([result])).captureTruncated).toBe(false);
  });

  it("records a fully captured, non-empty run as COMPLETE with matching byte accounting", async () => {
    const result = await runOnce([
      { type: "stdout", message: "1 passed\n", rawByteCount: 9 },
      { type: "stderr", message: "warn\n", rawByteCount: 5 },
      { type: "exit", result: exitResult({ exitCode: 0, stdoutBytes: 9, stderrBytes: 5 }) }
    ]);

    expect(result.stdoutCapture).toMatchObject({
      captureCompleteness: "COMPLETE", emptyOutputReason: "NOT_EMPTY",
      rawByteCount: 9, deliveredByteCount: 9, capturedByteCount: 9, includedByteCount: 9,
      upstreamOmittedByteCount: 0, truncationOmittedByteCount: 0, captureTruncated: false
    });
    expect(result.stderrCapture.captureCompleteness).toBe("COMPLETE");
    expect(result.stdoutPreview).toBe("1 passed\n");
  });

  it("refuses to build a verification artifact that claims complete capture while the runner reported discarded output", () => {
    expect(() => buildVerificationArtifact([{
      operation: "NPM_TEST", displayCommand: "npm test", passed: true, exitCode: 0, timedOut: false, cancelled: false,
      summary: "npm test passed.",
      stdoutPreview: "", stdoutTruncated: false,
      stdoutProvenance: { producerTruncated: false, captureTruncated: false, originalByteCount: 0, includedByteCount: 0, omittedByteCount: 0, truncationMethod: "NONE", fullContentSha256: "0".repeat(64) },
      stderrPreview: "", stderrTruncated: false,
      stderrProvenance: { producerTruncated: false, captureTruncated: false, originalByteCount: 0, includedByteCount: 0, omittedByteCount: 0, truncationMethod: "NONE", fullContentSha256: "0".repeat(64) },
      // The contradiction under test: the runner says output was discarded,
      // both streams claim complete capture.
      runnerOutputTruncated: true, runnerStdoutBytes: 5_000, runnerStderrBytes: 0,
      stdoutCapture: {
        schemaVersion: "stream-capture-provenance-v1", stream: "stdout", rawByteCount: 0, deliveredByteCount: 0,
        capturedByteCount: 0, includedByteCount: 0, upstreamOmittedByteCount: 0, redactionOmittedByteCount: 0,
        truncationOmittedByteCount: 0, captureTruncated: false, truncationMethod: "NONE",
        fullStreamContentHash: "0".repeat(64), capturedContentHash: "0".repeat(64),
        emptyOutputReason: "LEGITIMATE_EMPTY", captureCompleteness: "COMPLETE"
      },
      stderrCapture: {
        schemaVersion: "stream-capture-provenance-v1", stream: "stderr", rawByteCount: 0, deliveredByteCount: 0,
        capturedByteCount: 0, includedByteCount: 0, upstreamOmittedByteCount: 0, redactionOmittedByteCount: 0,
        truncationOmittedByteCount: 0, captureTruncated: false, truncationMethod: "NONE",
        fullStreamContentHash: "0".repeat(64), capturedContentHash: "0".repeat(64),
        emptyOutputReason: "LEGITIMATE_EMPTY", captureCompleteness: "COMPLETE"
      },
      startedAt: "2026-08-05T00:00:00.000Z", finishedAt: "2026-08-05T00:00:01.000Z", resultHash: "a".repeat(64)
    }])).toThrow(/neither stream records any loss/);
  });
});
