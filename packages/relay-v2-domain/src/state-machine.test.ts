import { describe, expect, it } from "vitest";
import { assertTaskTransition, canTransitionTask, MILESTONE_1_TRANSITIONS } from "./state-machine.js";

describe("Relay v2 task state machine", () => {
  it.each(MILESTONE_1_TRANSITIONS)("allows %s -> %s", (from, to) => {
    expect(canTransitionTask(from, to)).toBe(true);
    expect(() => assertTaskTransition(from, to)).not.toThrow();
  });

  it("rejects invalid and execution-skipping transitions", () => {
    expect(() => assertTaskTransition("PENDING_APPROVAL", "RUNNING")).toThrow(/cannot transition/i);
    expect(() => assertTaskTransition("APPROVED", "COMPLETED")).toThrow(/cannot transition/i);
    expect(() => assertTaskTransition("CANCELLED", "PENDING_APPROVAL")).toThrow(/cannot transition/i);
  });
});
