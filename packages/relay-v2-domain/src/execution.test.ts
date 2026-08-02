import { describe, expect, it } from "vitest";
import { EXECUTION_TRANSITIONS, assertExecutionTransition, executionStatusSchema, isTerminalExecutionStatus } from "./execution.js";

describe("execution state machine", () => {
  it("accepts every declared transition", () => {
    for (const from of executionStatusSchema.options) for (const to of EXECUTION_TRANSITIONS[from]) {
      expect(() => assertExecutionTransition(from, to)).not.toThrow();
    }
  });

  it("rejects every undeclared transition and keeps terminal states immutable", () => {
    for (const from of executionStatusSchema.options) for (const to of executionStatusSchema.options) {
      if (!EXECUTION_TRANSITIONS[from].includes(to)) expect(() => assertExecutionTransition(from, to)).toThrow();
    }
    for (const status of executionStatusSchema.options.filter(isTerminalExecutionStatus)) expect(EXECUTION_TRANSITIONS[status]).toEqual([]);
  });
});
