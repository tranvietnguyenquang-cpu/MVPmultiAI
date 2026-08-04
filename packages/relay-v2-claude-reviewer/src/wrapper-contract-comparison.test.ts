import { describe, expect, it } from "vitest";
import { claudeCliV2_1_220SampleVerdict, claudeCliV2_1_220WrapperFixture, CLAUDE_CLI_V2_1_220_FIXTURE_HASHES } from "./claude-cli-v2-1-220-wrapper.fixture.js";
import { compareWrapperToVerifiedContract } from "./wrapper-contract-comparison.js";

/**
 * The comparator decides whether an observed CLI version's wrapper may reuse
 * the registered contract. It must therefore describe the CONTRACT, not one
 * sample of it: deriving expected types from the fixture's values reported a
 * perfectly valid `fast_mode_disabled_reason: "..."` as a contract violation,
 * because the sample happened to carry `null` there.
 *
 * It must also stay strict in the other direction: an unknown field, a wrong
 * authority value, or a wrapper the production parser rejects can never be
 * reported as identical.
 */

const expectedEcho = {
  requestHash: CLAUDE_CLI_V2_1_220_FIXTURE_HASHES.reviewedRequestHash,
  materialHash: CLAUDE_CLI_V2_1_220_FIXTURE_HASHES.reviewedMaterialHash,
  promptHash: CLAUDE_CLI_V2_1_220_FIXTURE_HASHES.reviewedPromptHash
};

function compare(overrides: Record<string, unknown> = {}) {
  return compareWrapperToVerifiedContract({
    rawStdout: JSON.stringify(claudeCliV2_1_220WrapperFixture(claudeCliV2_1_220SampleVerdict(), overrides)),
    expectedEcho
  });
}

describe("wrapper contract comparison", () => {
  it("reports the reference wrapper as structurally identical", () => {
    const result = compare();
    expect(result.structurallyIdenticalToVerifiedContract).toBe(true);
    expect(result.topLevelKeys.identical).toBe(true);
    expect(result.authorityFields.allExactlyAsRequired).toBe(true);
    expect(result.resultAndStructuredOutputCanonicallyEqual).toBe(true);
    expect(result.hashEcho).toEqual({ requestHash: "MATCH", materialHash: "MATCH", promptHash: "MATCH" });
    expect(result.strictProductionParser.accepts).toBe(true);
  });

  // The exact defect the 2.1.221 diagnostic surfaced.
  const nullableFields = ["fast_mode_disabled_reason", "stop_reason", "terminal_reason"] as const;

  it.each(nullableFields)("accepts a STRING value for the nullable telemetry field %s", field => {
    const result = compare({ [field]: "a real reason string" });
    const comparison = result.fieldTypes.find(entry => entry.field === field)!;

    expect(comparison.expectedType).toBe("string | null");
    expect(comparison.actualType).toBe("string");
    expect(comparison.matches).toBe(true);
    expect(result.structurallyIdenticalToVerifiedContract).toBe(true);
  });

  it.each(nullableFields)("accepts a NULL value for the nullable telemetry field %s", field => {
    const result = compare({ [field]: null });
    expect(result.fieldTypes.find(entry => entry.field === field)!.matches).toBe(true);
    expect(result.structurallyIdenticalToVerifiedContract).toBe(true);
  });

  it("reports the observed 2.1.221 shape — string reasons on every nullable field — as identical", () => {
    const result = compare({
      fast_mode_disabled_reason: "fast mode unavailable for this account",
      stop_reason: "end_turn",
      terminal_reason: "completed"
    });
    expect(result.structurallyIdenticalToVerifiedContract).toBe(true);
    expect(result.topLevelKeys.missing).toEqual([]);
    expect(result.topLevelKeys.unexpected).toEqual([]);
    expect(result.strictProductionParser.accepts).toBe(true);
  });

  it.each(nullableFields)("still rejects a type outside the declared union for %s", field => {
    const result = compare({ [field]: 42 });
    const comparison = result.fieldTypes.find(entry => entry.field === field)!;

    expect(comparison.actualType).toBe("number");
    expect(comparison.matches).toBe(false);
    expect(result.structurallyIdenticalToVerifiedContract).toBe(false);
    expect(result.strictProductionParser.accepts).toBe(false);
  });

  it("does not widen a non-nullable telemetry field just because another field is nullable", () => {
    const result = compare({ fast_mode_state: null });
    const comparison = result.fieldTypes.find(entry => entry.field === "fast_mode_state")!;

    expect(comparison.expectedType).toBe("string");
    expect(comparison.matches).toBe(false);
    expect(result.structurallyIdenticalToVerifiedContract).toBe(false);
  });

  const authorityViolations: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ["type", { type: "error" }],
    ["subtype", { subtype: "failure" }],
    ["is_error", { is_error: true }],
    ["api_error_status", { api_error_status: "overloaded" }],
    ["permission_denials", { permission_denials: [{ tool: "Bash" }] }]
  ];

  it.each(authorityViolations)("never reports identity when the authority field %s is wrong", (_field, override) => {
    const result = compare(override);
    expect(result.authorityFields.allExactlyAsRequired).toBe(false);
    expect(result.structurallyIdenticalToVerifiedContract).toBe(false);
    expect(result.strictProductionParser.accepts).toBe(false);
  });

  it("reports an unknown top-level field as unexpected and never as identical", () => {
    const result = compare({ new_telemetry_field: 1 });
    expect(result.topLevelKeys.unexpected).toEqual(["new_telemetry_field"]);
    expect(result.structurallyIdenticalToVerifiedContract).toBe(false);
    // The production parser's `.strict()` unknown-field rejection is unchanged.
    expect(result.strictProductionParser.accepts).toBe(false);
  });

  it("reports a missing field rather than tolerating its absence", () => {
    const wrapper = claudeCliV2_1_220WrapperFixture() as Record<string, unknown>;
    delete wrapper.stop_reason;
    const result = compareWrapperToVerifiedContract({ rawStdout: JSON.stringify(wrapper), expectedEcho });

    expect(result.topLevelKeys.missing).toEqual(["stop_reason"]);
    expect(result.fieldTypes.find(entry => entry.field === "stop_reason")).toMatchObject({ present: false, actualType: "absent", matches: false });
    expect(result.structurallyIdenticalToVerifiedContract).toBe(false);
  });

  it("reports a result/structured_output disagreement rather than trusting one side", () => {
    const result = compare({ result: JSON.stringify(claudeCliV2_1_220SampleVerdict({ verdict: "REJECT", summary: "different", findings: [{ id: "f", severity: "BLOCKER", category: "c", title: "t", description: "d", evidenceReferences: [], blocking: true }] })) });
    expect(result.resultAndStructuredOutputCanonicallyEqual).toBe(false);
    expect(result.structurallyIdenticalToVerifiedContract).toBe(false);
  });

  it("reports a hash the model failed to echo verbatim", () => {
    const result = compareWrapperToVerifiedContract({
      rawStdout: JSON.stringify(claudeCliV2_1_220WrapperFixture()),
      expectedEcho: { ...expectedEcho, promptHash: "9".repeat(64) }
    });
    expect(result.hashEcho.promptHash).toBe("MISMATCH");
    expect(result.structurallyIdenticalToVerifiedContract).toBe(false);
  });

  it("handles non-JSON output without throwing, and never calls it identical", () => {
    const result = compareWrapperToVerifiedContract({ rawStdout: "not json at all" });
    expect(result.parsedAsSingleJsonObject).toBe(false);
    expect(result.structurallyIdenticalToVerifiedContract).toBe(false);
    expect(result.strictProductionParser.accepts).toBe(false);
  });
});
