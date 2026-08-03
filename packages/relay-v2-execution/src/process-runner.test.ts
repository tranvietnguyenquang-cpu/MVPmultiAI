import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  SafeProcessRunner,
  type OwnedProcessTerminator,
  type ProcessRunnerEvent
} from "./process-runner.js";

class TestTerminator implements OwnedProcessTerminator {
  readonly terminate = vi.fn(async (child: ChildProcessWithoutNullStreams) => { child.kill(); });
}

const longRunningArgs = ["-e", "setInterval(()=>{},1000)"];

describe("SafeProcessRunner", () => {
  let workspace: string;

  beforeAll(async () => { workspace = await mkdtemp(path.join(tmpdir(), "relay-v2-runner-unicode-测试-")); });
  afterAll(async () => { await rm(workspace, { recursive: true, force: true }); });

  async function collect(runner: SafeProcessRunner, args: string[], options: { stdin?: string; timeoutMs?: number; maxOutputBytes?: number } = {}) {
    const events: ProcessRunnerEvent[] = [];
    for await (const event of runner.run({
      executionId: crypto.randomUUID(), executablePath: process.execPath, args, cwd: workspace,
      timeoutMs: options.timeoutMs ?? 2_000,
      ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
      ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
      environment: { PATH: process.env.PATH, TEMP: process.env.TEMP, OPENAI_API_KEY: "must-not-leak" }
    })) events.push(event);
    return events;
  }

  it("streams redacted stdout/stderr and preserves shell-like stdin as data", async () => {
    const events = await collect(new SafeProcessRunner(), ["-e", "process.stdin.on('data',d=>{console.log(d.toString());console.error('token=supersecretvalue')})"], { stdin: "; Write-Output hacked && exit 99" });
    expect(events.find(event => event.type === "started")).toBeTruthy();
    expect(events.filter(event => event.type === "stdout").map(event => event.type === "stdout" ? event.message : "").join("")).toContain("; Write-Output hacked && exit 99");
    const stderr = events.filter(event => event.type === "stderr").map(event => event.type === "stderr" ? event.message : "").join("");
    expect(stderr).toContain("[REDACTED]");
    expect(stderr).not.toContain("supersecretvalue");
    expect(events.at(-1)).toMatchObject({ type: "exit", result: { exitCode: 0, timedOut: false, cancelled: false } });
  });

  it("reports an exact nonzero exit code", async () => {
    const events = await collect(new SafeProcessRunner(), ["-e", "process.exit(7)"]);
    expect(events.at(-1)).toMatchObject({ type: "exit", result: { exitCode: 7 } });
  });

  it("bounds output previews", async () => {
    const events = await collect(new SafeProcessRunner(), ["-e", "process.stdout.write('x'.repeat(4096))"], { maxOutputBytes: 128 });
    expect(events).toContainEqual(expect.objectContaining({ type: "warning" }));
    expect(events.at(-1)).toMatchObject({ type: "exit", result: { outputTruncated: true, stdoutBytes: 4096 } });
  });

  it("cancels only the exact owned process identity and supports timeout", async () => {
    const terminator = new TestTerminator();
    const runner = new SafeProcessRunner(terminator);
    const executionId = crypto.randomUUID();
    const events: ProcessRunnerEvent[] = [];
    for await (const event of runner.run({
      executionId, executablePath: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], cwd: workspace, timeoutMs: 2_000
    })) {
      events.push(event);
      if (event.type === "started") {
        expect(runner.owns(executionId, event.ownership)).toBe(true);
        expect(runner.owns(executionId, { ...event.ownership, processIdentity: "forged" })).toBe(false);
        await runner.cancel(executionId);
      }
    }
    expect(terminator.terminate).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toMatchObject({ type: "exit", result: { cancelled: true, timedOut: false } });

    const timeoutTerminator = new TestTerminator();
    const timeoutEvents = await collect(new SafeProcessRunner(timeoutTerminator), ["-e", "setInterval(()=>{},1000)"], { timeoutMs: 20 });
    expect(timeoutEvents.at(-1)).toMatchObject({ type: "exit", result: { timedOut: true, cancelled: false } });
  });

  it("does not spawn when the signal is already aborted", async () => {
    const terminator = new TestTerminator();
    const stages: string[] = [];
    const controller = new AbortController();
    controller.abort();
    const events: ProcessRunnerEvent[] = [];
    for await (const event of new SafeProcessRunner(terminator, { onStage: stage => { stages.push(stage); } }).run({
      executionId: crypto.randomUUID(), executablePath: process.execPath, args: longRunningArgs, cwd: workspace, timeoutMs: 2_000
    }, controller.signal)) events.push(event);
    expect(stages).toEqual([]);
    expect(terminator.terminate).not.toHaveBeenCalled();
    expect(events).toEqual([expect.objectContaining({ type: "exit", result: expect.objectContaining({ cancelled: true }) })]);
  });

  it.each(["before-validation", "after-validation", "before-spawn"] as const)("closes the %s cancellation window before spawn", async stageToAbort => {
    const controller = new AbortController();
    const terminator = new TestTerminator();
    const stages: string[] = [];
    const events: ProcessRunnerEvent[] = [];
    const runner = new SafeProcessRunner(terminator, { onStage: async stage => {
      stages.push(stage);
      if (stage === stageToAbort) controller.abort();
    } });
    for await (const event of runner.run({
      executionId: crypto.randomUUID(), executablePath: process.execPath, args: longRunningArgs, cwd: workspace, timeoutMs: 2_000
    }, controller.signal)) events.push(event);
    expect(stages).toContain(stageToAbort);
    expect(events.some(event => event.type === "started")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "exit", result: { cancelled: true, timedOut: false } });
    expect(terminator.terminate).not.toHaveBeenCalled();
  });

  it("observes abort while asynchronous request validation is in progress", async () => {
    const controller = new AbortController();
    let releaseValidation!: () => void;
    let validationStarted!: () => void;
    const validationStartedPromise = new Promise<void>(resolve => { validationStarted = resolve; });
    const validationGate = new Promise<void>(resolve => { releaseValidation = resolve; });
    const terminator = new TestTerminator();
    const runner = new SafeProcessRunner(terminator, {
      validateRequest: async request => {
        validationStarted();
        await validationGate;
        return { executablePath: request.executablePath, cwd: request.cwd };
      }
    });
    const events: ProcessRunnerEvent[] = [];
    const collecting = (async () => {
      for await (const event of runner.run({
        executionId: crypto.randomUUID(), executablePath: process.execPath, args: longRunningArgs, cwd: workspace, timeoutMs: 2_000
      }, controller.signal)) events.push(event);
    })();
    await validationStartedPromise;
    controller.abort();
    releaseValidation();
    await collecting;
    expect(terminator.terminate).not.toHaveBeenCalled();
    expect(events.some(event => event.type === "started")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "exit", result: { cancelled: true } });
  });

  it("terminates an abort immediately after spawn before delivering started", async () => {
    const controller = new AbortController();
    const terminator = new TestTerminator();
    const events: ProcessRunnerEvent[] = [];
    const runner = new SafeProcessRunner(terminator, { onStage: stage => { if (stage === "after-spawn") controller.abort(); } });
    for await (const event of runner.run({
      executionId: crypto.randomUUID(), executablePath: process.execPath, args: longRunningArgs, cwd: workspace, timeoutMs: 2_000
    }, controller.signal)) events.push(event);
    expect(events.some(event => event.type === "started")).toBe(false);
    expect(terminator.terminate).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toMatchObject({ type: "exit", result: { cancelled: true, timedOut: false } });
  });

  it("keeps ownership until a process exits when termination fails", async () => {
    const terminator: OwnedProcessTerminator = { terminate: vi.fn(async () => { throw new Error("token=supersecretvalue"); }) };
    const controller = new AbortController();
    let ownership: Extract<ProcessRunnerEvent, { type: "started" }>["ownership"] | undefined;
    const executionId = crypto.randomUUID();
    const runner = new SafeProcessRunner(terminator);
    const events: ProcessRunnerEvent[] = [];
    for await (const event of runner.run({
      executionId, executablePath: process.execPath, args: ["-e", "setTimeout(()=>process.exit(0),80)"], cwd: workspace, timeoutMs: 2_000
    }, controller.signal)) {
      events.push(event);
      if (event.type === "started") {
        ownership = event.ownership;
        controller.abort();
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(runner.owns(executionId, ownership)).toBe(true);
      }
    }
    expect(ownership).toBeDefined();
    expect(runner.owns(executionId, ownership!)).toBe(false);
    const warnings = events.filter(event => event.type === "warning").map(event => event.type === "warning" ? event.message : "").join(" ");
    expect(warnings).toContain("retain ownership");
    expect(warnings).not.toContain("supersecretvalue");
    expect(events.at(-1)).toMatchObject({ type: "exit", result: { cancelled: true } });
  });

  it("deduplicates timeout racing cancellation with the first termination reason", async () => {
    const terminator = new TestTerminator();
    const controller = new AbortController();
    const events: ProcessRunnerEvent[] = [];
    const runner = new SafeProcessRunner(terminator);
    for await (const event of runner.run({
      executionId: crypto.randomUUID(), executablePath: process.execPath, args: longRunningArgs, cwd: workspace, timeoutMs: 15
    }, controller.signal)) {
      events.push(event);
      if (event.type === "started") setTimeout(() => controller.abort(), 30);
    }
    expect(terminator.terminate).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toMatchObject({ type: "exit", result: { timedOut: true, cancelled: false } });
  });
});
