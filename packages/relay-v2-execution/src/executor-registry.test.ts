import { describe, expect, it } from "vitest";
import { FakeExecutor } from "./fake-executor.js";
import { ExecutorRegistry } from "./executor-registry.js";

describe("ExecutorRegistry", () => {
  it("maps only explicitly supported approval selections", () => {
    const registry = new ExecutorRegistry([new FakeExecutor()]);
    expect(registry.forApprovedSelection("FAKE")?.id).toBe("fake");
    expect(registry.forApprovedSelection("CODEX")).toBeUndefined();
    expect(registry.forApprovedSelection("AUTO")).toBeUndefined();
    expect(registry.forApprovedSelection("CLAUDE")).toBeUndefined();
  });
});
