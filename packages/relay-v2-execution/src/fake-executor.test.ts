import { describe, expect, it } from "vitest";
import { ImmediateExecutionClock } from "./clock.js";
import { FakeExecutor } from "./fake-executor.js";

describe("FakeExecutor contract", () => {
  it("emits deterministic in-process output and warnings with a fast injected clock", async () => {
    const executor = new FakeExecutor({ scenario: { eventCount: 3, delayMs: 1_000, warningAt: [1], outcome: "success" } });
    const prepared = await executor.prepare({
      sessionId: "session", taskId: "task", projectId: "project", workspacePath: "C:\\fake",
      approvedExecutor: "FAKE", approvedModel: "AUTO", approvedEffort: "MEDIUM", approvedReviewer: "NONE",
      approvedPermissions: [{ permission: "ALLOW_SOURCE_TRANSMISSION_TO_API", value: false }],
      timeoutMs: 30_000, verificationOperations: [], title: "Fake", objective: "Fake", taskContext: "",
      constraints: [], acceptanceCriteria: []
    });
    const clock = new ImmediateExecutionClock();
    const events = [];
    for await (const event of executor.execute(prepared, { signal: new AbortController().signal, now: () => clock.now(), sleep: value => clock.sleep(value) })) events.push(event);
    expect(events.map(event => event.type)).toEqual(["output", "warning", "output", "result"]);
    expect(clock.now().getTime()).toBe(new Date("2026-08-02T00:00:00.000Z").getTime() + 3_000);
    expect(executor.describe()).toMatchObject({ id: "fake", writeCapability: false, providerType: "FAKE" });
  });
});
