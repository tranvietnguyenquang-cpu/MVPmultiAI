import { createHash } from "node:crypto";
import { access, realpath } from "node:fs/promises";
import path from "node:path";
import {
  boundTextToBytes, buildStreamCaptureProvenance, canonicalJson, sha256OfText, untruncatedProvenance,
  verificationOperationSchema,
  type ProducerTruncation, type StreamCaptureProvenance, type VerificationOperation
} from "@project-relay/relay-v2-domain";
import { SafeProcessRunner, type ProcessRunner, type ProcessRunnerEvent } from "./process-runner.js";

const MAX_STREAM_PREVIEW_BYTES = 16_384;

/**
 * Inserted where a verification stream was cut. A stream is bounded
 * HEAD_AND_TAIL rather than HEAD-only so a FAILED operation's
 * failure-relevant tail -- conventionally where the error actually is --
 * survives truncation instead of being the first thing discarded.
 */
const STREAM_OMISSION_MARKER = "\n...[verification output truncated; head and tail shown]...\n";

export type VerificationResult = {
  operation: VerificationOperation;
  displayCommand: string;
  passed: boolean;
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  summary: string;
  /** Bounded, redacted stdout/stderr captured from this exact run -- evidence for an authoritative reviewer, not just a templated pass/fail sentence. */
  stdoutPreview: string;
  stdoutTruncated: boolean;
  /** Truthful provenance for `stdoutPreview`, computed from the complete redacted stream before any cut. */
  stdoutProvenance: ProducerTruncation;
  stderrPreview: string;
  stderrTruncated: boolean;
  /** Truthful provenance for `stderrPreview`, computed from the complete redacted stream before any cut. */
  stderrProvenance: ProducerTruncation;
  /**
   * Runner-boundary output loss, carried through instead of discarded.
   *
   * SafeProcessRunner counts every byte the process writes but stops
   * FORWARDING once the combined cap is reached. Reading only `exitCode` from
   * the exit event -- which this runner previously did -- can therefore
   * persist an empty captured stream, `captureTruncated: false`, and a PASSED
   * status for an operation whose output was thrown away. These three fields
   * plus the per-stream capture provenance below make that state
   * unrepresentable.
   */
  runnerOutputTruncated: boolean;
  runnerStdoutBytes: number;
  runnerStderrBytes: number;
  /** Exact per-stream capture accounting, from bytes written to bytes rendered. */
  stdoutCapture: StreamCaptureProvenance;
  stderrCapture: StreamCaptureProvenance;
  startedAt: string;
  finishedAt: string;
  /**
   * Self-referential integrity hash over every other field of this exact
   * result (sha256 of its canonicalized JSON, computed with this field
   * itself excluded) -- lets a strict evidence schema detect a result that
   * was edited in place after being produced, independent of the outer
   * ExecutionSession.verificationResultsHash (which only proves the
   * *persisted JSON string* has not changed, not that any one entry within
   * it is internally self-consistent).
   */
  resultHash: string;
};

function computeResultHash(result: Omit<VerificationResult, "resultHash">): string {
  return createHash("sha256").update(canonicalJson(result), "utf8").digest("hex");
}

/**
 * Bounds one verification stream to the preview budget, cutting only on
 * complete Unicode code points and recording provenance measured from the
 * COMPLETE redacted stream. The previous implementation sliced a Buffer at a
 * fixed offset (which can split a multibyte sequence into U+FFFD) and
 * reported no original size at all.
 */
function boundStream(
  stream: "stdout" | "stderr",
  captured: string,
  runner: { rawByteCount: number; deliveredByteCount: number | null; outputTruncated: boolean }
): { preview: string; truncated: boolean; provenance: ProducerTruncation; capture: StreamCaptureProvenance } {
  // Already redacted chunk-by-chunk as it arrived; redacting again is a no-op
  // on redacted text and would double-count the redaction cost.
  const bounded = boundTextToBytes(captured, MAX_STREAM_PREVIEW_BYTES, "HEAD_AND_TAIL", STREAM_OMISSION_MARKER);
  const capture = buildStreamCaptureProvenance({
    stream,
    rawByteCount: runner.rawByteCount,
    deliveredByteCount: runner.deliveredByteCount,
    runnerOutputTruncated: runner.outputTruncated,
    capturedText: captured,
    includedText: bounded.text,
    includedContentByteCount: bounded.includedContentByteCount,
    truncationMethod: bounded.truncationMethod
  });
  // The pre-existing ProducerTruncation projection stays the blocking signal
  // every consumer already understands: `captureTruncated` is now set for
  // upstream loss, which is what makes an unknown loss block an AUTHORITATIVE
  // review rather than passing as complete evidence.
  const upstreamLoss = capture.captureCompleteness === "TRUNCATED_UNKNOWN";
  if (!bounded.truncated) {
    // `captureTruncated` is what states that these counts and this hash
    // describe only the portion this producer actually held -- they are never
    // presented as the complete stream when bytes were lost above it.
    return { preview: bounded.text, truncated: false, provenance: untruncatedProvenance(captured, upstreamLoss), capture };
  }
  return {
    preview: bounded.text,
    truncated: true,
    provenance: {
      producerTruncated: true,
      captureTruncated: upstreamLoss,
      originalByteCount: bounded.originalByteCount,
      includedByteCount: bounded.includedContentByteCount,
      omittedByteCount: bounded.omittedByteCount,
      truncationMethod: bounded.truncationMethod,
      fullContentSha256: sha256OfText(captured)
    },
    capture
  };
}

/** The provenance of a stream that legitimately produced nothing because no process ever ran. */
function emptyCapture(stream: "stdout" | "stderr"): StreamCaptureProvenance {
  return buildStreamCaptureProvenance({
    stream, rawByteCount: 0, deliveredByteCount: 0, runnerOutputTruncated: false,
    capturedText: "", includedText: "", includedContentByteCount: 0, truncationMethod: "NONE"
  });
}

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
    if (!npmCli) {
      const now = new Date().toISOString();
      return operations.map(operation => {
        const withoutHash = {
          operation, displayCommand: definitions[operation].displayCommand, passed: false, exitCode: null,
          timedOut: false, cancelled: false, summary: "The server-owned npm CLI entry point was not found.",
          stdoutPreview: "", stdoutTruncated: false, stdoutProvenance: untruncatedProvenance(""),
          stderrPreview: "", stderrTruncated: false, stderrProvenance: untruncatedProvenance(""),
          runnerOutputTruncated: false, runnerStdoutBytes: 0, runnerStderrBytes: 0,
          // No process ever ran, so both streams are legitimately empty --
          // stated explicitly rather than left to be inferred from silence.
          stdoutCapture: emptyCapture("stdout"), stderrCapture: emptyCapture("stderr"),
          startedAt: now, finishedAt: now
        };
        return { ...withoutHash, resultHash: computeResultHash(withoutHash) };
      });
    }
    const results: VerificationResult[] = [];
    for (const operation of operations) {
      const definition = definitions[operation];
      let exitCode: number | null = null;
      let timedOut = false;
      let cancelled = false;
      let stdout = "";
      let stderr = "";
      // Raw bytes this consumer actually received, tracked separately from the
      // runner's own totals so redaction (which shrinks text without losing
      // output) is never mistaken for output the runner discarded, and the
      // reverse is never mistaken for redaction. `null` means the runner did
      // not report per-chunk sizes, which is reported as unknown attribution
      // rather than assumed to be zero loss.
      let deliveredStdoutBytes: number | null = 0;
      let deliveredStderrBytes: number | null = 0;
      let runnerOutputTruncated = false;
      let runnerStdoutBytes = 0;
      let runnerStderrBytes = 0;
      const startedAt = new Date().toISOString();
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
        if (event.type === "stdout") {
          stdout += event.message;
          deliveredStdoutBytes = event.rawByteCount === undefined || deliveredStdoutBytes === null ? null : deliveredStdoutBytes + event.rawByteCount;
        } else if (event.type === "stderr") {
          stderr += event.message;
          deliveredStderrBytes = event.rawByteCount === undefined || deliveredStderrBytes === null ? null : deliveredStderrBytes + event.rawByteCount;
        } else if (event.type === "exit") {
          exitCode = event.result.exitCode;
          timedOut = event.result.timedOut;
          cancelled = event.result.cancelled;
          runnerOutputTruncated = event.result.outputTruncated;
          runnerStdoutBytes = event.result.stdoutBytes;
          runnerStderrBytes = event.result.stderrBytes;
        }
      }
      const finishedAt = new Date().toISOString();
      const passed = exitCode === 0 && !timedOut && !cancelled;
      const boundedStdout = boundStream("stdout", stdout, { rawByteCount: runnerStdoutBytes, deliveredByteCount: deliveredStdoutBytes, outputTruncated: runnerOutputTruncated });
      const boundedStderr = boundStream("stderr", stderr, { rawByteCount: runnerStderrBytes, deliveredByteCount: deliveredStderrBytes, outputTruncated: runnerOutputTruncated });
      const withoutHash = {
        operation, displayCommand: definition.displayCommand, passed, exitCode, timedOut, cancelled,
        // A PASS never overrides missing evidence: the summary says so, and
        // the provenance below blocks an AUTHORITATIVE review outright.
        summary: passed
          ? `${definition.displayCommand} passed${boundedStdout.capture.captureCompleteness === "TRUNCATED_UNKNOWN" || boundedStderr.capture.captureCompleteness === "TRUNCATED_UNKNOWN" ? ", but some of its output was lost before Relay could record it." : "."}`
          : `${definition.displayCommand} failed with exit code ${exitCode ?? "unknown"}.`,
        stdoutPreview: boundedStdout.preview, stdoutTruncated: boundedStdout.truncated, stdoutProvenance: boundedStdout.provenance,
        stderrPreview: boundedStderr.preview, stderrTruncated: boundedStderr.truncated, stderrProvenance: boundedStderr.provenance,
        runnerOutputTruncated, runnerStdoutBytes, runnerStderrBytes,
        stdoutCapture: boundedStdout.capture, stderrCapture: boundedStderr.capture,
        startedAt, finishedAt
      };
      results.push({ ...withoutHash, resultHash: computeResultHash(withoutHash) });
      if (!passed) break;
    }
    return results;
  }
}
