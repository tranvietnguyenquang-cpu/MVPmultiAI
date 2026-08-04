import { describe, expect, it } from "vitest";
import type { ProcessRunRequest, ProcessRunner, ProcessRunnerEvent } from "./process-runner.js";
import { VerificationCatalogRunner } from "./verification-catalog.js";

class VerificationProcessDouble implements ProcessRunner {
  readonly requests: ProcessRunRequest[] = [];
  constructor(private readonly exitCodes: number[]) {}
  owns(): boolean { return false; }
  async cancel(): Promise<boolean> { return false; }
  async *run(request: ProcessRunRequest): AsyncIterable<ProcessRunnerEvent> {
    this.requests.push(request);
    yield { type: "exit", result: { exitCode: this.exitCodes.shift() ?? 0, signal: null, timedOut: false, cancelled: false, outputTruncated: false, stdoutBytes: 0, stderrBytes: 0 } };
  }
}

describe("VerificationCatalogRunner", () => {
  it("uses only server-owned argv definitions and stops after a failure", async () => {
    const processDouble = new VerificationProcessDouble([0, 9, 0]);
    const runner = new VerificationCatalogRunner(processDouble, process.execPath);
    const results = await runner.run({
      sessionId: "session", workspacePath: process.cwd(), operations: ["NPM_TEST", "NPM_TYPECHECK", "NPM_BUILD"],
      timeoutMs: 1_000, signal: new AbortController().signal
    });
    expect(results.map(result => result.passed)).toEqual([true, false]);
    expect(processDouble.requests).toHaveLength(2);
    expect(processDouble.requests[0]?.args.slice(-1)).toEqual(["test"]);
    expect(processDouble.requests[1]?.args.slice(-2)).toEqual(["run", "typecheck"]);
    expect(processDouble.requests.every(request => pathIsAbsolute(request.executablePath))).toBe(true);
  });

  it("stamps each result with a self-consistent resultHash covering every other field", async () => {
    const processDouble = new VerificationProcessDouble([0]);
    const runner = new VerificationCatalogRunner(processDouble, process.execPath);
    const results = await runner.run({
      sessionId: "session", workspacePath: process.cwd(), operations: ["NPM_TEST"],
      timeoutMs: 1_000, signal: new AbortController().signal
    });
    const { resultHash, ...rest } = results[0]!;
    expect(resultHash).toMatch(/^[a-f0-9]{64}$/);
    const { createHash } = await import("node:crypto");
    const { canonicalJson } = await import("@project-relay/relay-v2-domain");
    expect(createHash("sha256").update(canonicalJson(rest), "utf8").digest("hex")).toBe(resultHash);
  });
});

function pathIsAbsolute(value: string): boolean { return /^(?:[A-Za-z]:[\\/]|\/)/.test(value); }
