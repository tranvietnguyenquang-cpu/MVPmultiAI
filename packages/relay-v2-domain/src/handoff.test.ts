import { describe, expect, it } from "vitest";
import { HandoffValidationError, MAX_HANDOFF_BYTES, hashTaskSpec, parseHandoffText } from "./handoff.js";

const valid = {
  version: 1,
  project: { name: "Example", pathHint: "C:\\Example" },
  task: { title: "Fix import", objective: "Repair tenant import coverage", taskType: "implementation", complexity: "complex", context: "Existing import is incomplete." },
  constraints: ["Do not modify production"],
  acceptanceCriteria: ["Relevant tests pass"],
  execution: { executor: "codex", model: "auto", effort: "high", reviewer: "claude", requireApproval: true, allowSourceTransmissionToApi: false }
};

describe("Relay handoff v1", () => {
  it("accepts valid JSON and normalizes it", () => {
    const result = parseHandoffText(JSON.stringify(valid));
    expect(result.format).toBe("JSON");
    expect(result.normalized.task.taskType).toBe("IMPLEMENTATION");
    expect(result.normalized.execution).toMatchObject({ executor: "CODEX", model: "AUTO", effort: "HIGH", reviewer: "CLAUDE", requireApproval: true });
  });

  it("accepts safe YAML", () => {
    const yaml = `version: 1
project:
  name: Example
task:
  title: Fix import
  objective: Repair tenant import coverage
  taskType: implementation
  complexity: complex
acceptanceCriteria:
  - Relevant tests pass
execution:
  requireApproval: true
`;
    expect(parseHandoffText(yaml).format).toBe("YAML");
  });

  it("rejects malformed JSON", () => {
    expect(() => parseHandoffText('{"version":')).toThrow(HandoffValidationError);
  });

  it("rejects malformed YAML", () => {
    expect(() => parseHandoffText("version: 1\nproject: [unterminated")).toThrow(HandoffValidationError);
  });

  it("rejects unsupported YAML tags", () => {
    expect(() => parseHandoffText("version: 1\nproject: !unsafe value")).toThrow(/tag|yaml/i);
  });

  it("rejects oversized payloads", () => {
    expect(() => parseHandoffText("x".repeat(MAX_HANDOFF_BYTES + 1))).toThrow(/exceeds/i);
  });

  it("reports human-readable nested validation paths", () => {
    try {
      parseHandoffText(JSON.stringify({ ...valid, task: { ...valid.task, objective: "" } }));
      throw new Error("expected validation failure");
    } catch (error) {
      expect(error).toBeInstanceOf(HandoffValidationError);
      expect((error as HandoffValidationError).issues).toContainEqual(expect.objectContaining({ path: "task.objective" }));
    }
  });

  it("reports missing required fields", () => {
    try {
      parseHandoffText(JSON.stringify({ version: 1, project: { name: "Example" }, task: { title: "Missing fields" }, acceptanceCriteria: [] }));
      throw new Error("expected validation failure");
    } catch (error) {
      expect(error).toBeInstanceOf(HandoffValidationError);
      expect((error as HandoffValidationError).issues.map(issue => issue.path)).toEqual(expect.arrayContaining(["task.objective", "task.taskType", "task.complexity", "acceptanceCriteria"]));
    }
  });

  it("normalizes line endings, trims fields, and removes duplicate list entries", () => {
    const result = parseHandoffText(JSON.stringify({
      ...valid,
      task: { ...valid.task, title: "  Fix import  ", context: "a\r\nb" },
      constraints: [" Keep data ", "keep data"]
    }));
    expect(result.normalized.task).toMatchObject({ title: "Fix import", context: "a\nb" });
    expect(result.normalized.constraints).toEqual(["Keep data"]);
  });

  it("produces a stable hash for semantically normalized input", () => {
    const first = parseHandoffText(JSON.stringify(valid));
    const second = parseHandoffText(JSON.stringify({ ...valid, task: { ...valid.task, title: ` ${valid.task.title} ` } }));
    expect(hashTaskSpec(first.normalized)).toBe(hashTaskSpec(second.normalized));
  });

  it("rejects likely secrets before persistence", () => {
    expect(() => parseHandoffText(JSON.stringify({ ...valid, task: { ...valid.task, context: "api_key=supersecretvalue123" } }))).toThrow(/Possible secret/i);
  });
});
