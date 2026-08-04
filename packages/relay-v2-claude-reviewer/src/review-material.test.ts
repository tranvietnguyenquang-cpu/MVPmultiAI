import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AUTHORITATIVE_REVIEW_MATERIAL_BUDGET, MATERIAL_BUDGET_POLICY_VERSION, REVIEW_MATERIAL_ENVELOPE_VERSION,
  buildStreamCaptureProvenance, canonicalJson, reviewMaterialEnvelopeSchema
} from "@project-relay/relay-v2-domain";
import { buildReviewMaterialSections, type ImmutableReviewCapsule, type PreparedReviewMaterial } from "@project-relay/relay-v2-reviewer";
import {
  assertPromptWithinBudget, prepareClaudeInvocation, CLAUDE_PROMPT_POLICY, CLAUDE_PROMPT_POLICY_VERSION
} from "./review-material.js";

const hash64 = "a".repeat(64);
const REQUEST_HASH = "9".repeat(64);
const emptyGitEvidence = { available: false, branch: "", head: "", dirty: false, changedFiles: [], diffPreview: "", diffTruncated: false, diffOmittedForSensitivePaths: false };

function capture(stream: "stdout" | "stderr", text: string) {
  const byteCount = Buffer.byteLength(text, "utf8");
  return buildStreamCaptureProvenance({
    stream, rawByteCount: byteCount, deliveredByteCount: byteCount, runnerOutputTruncated: false,
    capturedText: text, includedText: text, includedContentByteCount: byteCount, truncationMethod: "NONE"
  });
}

function capsule(overrides: Partial<ImmutableReviewCapsule> = {}): ImmutableReviewCapsule {
  return {
    reviewRequestId: "22222222-2222-2222-2222-222222222222", executionSessionId: "33333333-3333-3333-3333-333333333333",
    projectId: "44444444-4444-4444-4444-444444444444", taskId: "55555555-5555-5555-5555-555555555555",
    reviewerId: "claude-cli", reviewAuthority: "AUTHORITATIVE", diagnostic: false,
    approvalId: "66666666-6666-6666-6666-666666666666", approvalStatus: "APPROVED", approvedReviewer: "CLAUDE", taskSelectedReviewer: "CLAUDE",
    executionExecutorId: "codex-cli", taskTitle: "Fix the bug", taskObjective: "Make it work", taskContext: "Some context",
    taskSpecHash: hash64, canonicalTaskSpecHash: hash64, taskNormalizedSpecHash: hash64, approvalSnapshotHash: hash64,
    executionStatus: "SUCCEEDED", executionResultStatus: "succeeded", executionSummary: "Did the thing", executionSummaryHash: hash64,
    executionCapsuleHash: hash64, executionCapsuleJsonHash: hash64, baselineGitEvidenceHash: hash64, finalGitEvidenceHash: hash64,
    verificationResultsHash: hash64, executionArtifactSetHash: hash64, finalBranch: "main", finalHead: "abc123",
    requestedAt: "2026-08-03T00:00:00.000Z", reviewPolicyVersion: "2.3A-v1",
    taskConstraints: ["Do not touch auth."], acceptanceCriteria: ["Tests pass."],
    approvedExecutorSelection: "CODEX", approvedModel: "AUTO", approvedEffort: "AUTO", approvedVerificationOperations: ["NPM_TEST"],
    baselineGitEvidence: emptyGitEvidence,
    finalGitEvidence: {
      available: true, branch: "main", head: "abc123", dirty: true,
      changedFiles: [{ path: "src/x.ts", status: "modified", binary: false }],
      diffPreview: "diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n+hello\n", diffTruncated: false, diffOmittedForSensitivePaths: false
    },
    verificationEvidence: [{
      operation: "NPM_TEST", displayCommand: "npm test", passed: true, exitCode: 0, timedOut: false, cancelled: false,
      summary: "npm test passed.", stdoutPreview: "1 passed", stdoutTruncated: false, stderrPreview: "", stderrTruncated: false,
      runnerOutputTruncated: false, runnerStdoutBytes: 8, runnerStderrBytes: 0,
      stdoutCapture: capture("stdout", "1 passed"), stderrCapture: capture("stderr", ""),
      startedAt: "2026-08-03T00:00:00.000Z", finishedAt: "2026-08-03T00:00:01.000Z", resultHash: "e".repeat(64)
    }],
    executionArtifactManifest: [{ artifactId: "77777777-7777-4777-8777-777777777777", artifactType: "PATCH", relativePath: "executions/x/final-patch.json", sha256: "b".repeat(64), byteCount: 42, truncated: false }],
    executionLogEvidence: {
      available: true, preview: "{\"type\":\"output\",\"message\":\"started\",\"payload\":{}}\n",
      producerProvenance: null, producerTruncated: false,
      sourceByteCount: 50, includedContentSha256: "f".repeat(64),
      reviewerIncludedByteCount: 50, reviewerOmittedByteCount: 0, reviewerMarkerByteCount: 0,
      reviewerFinalRenderedByteCount: 50, reviewerRenderedSha256: "a".repeat(64),
      reviewerTruncated: false, reviewerTruncationMethod: "NONE",
      reviewerIncludedRecordCount: 1, reviewerOmittedRecordCount: 0, anyTruncation: false
    },
    requestHash: REQUEST_HASH, reviewInputHash: hash64, reviewerConfigHash: "c".repeat(64), ...overrides
  };
}

/** Runs the real construction order: core, then ledger measured from it, then envelope serialized once, then prompt/stdin. */
function build(overrides: Partial<ImmutableReviewCapsule> = {}) {
  const subject = capsule(overrides);
  const sections = buildReviewMaterialSections(subject, CLAUDE_PROMPT_POLICY, subject.requestHash);
  const material: PreparedReviewMaterial = {
    materialEnvelopeVersion: REVIEW_MATERIAL_ENVELOPE_VERSION,
    materialBudgetPolicyVersion: MATERIAL_BUDGET_POLICY_VERSION,
    envelope: sections.envelope,
    materialCanonicalJson: sections.envelopeJson,
    materialByteCount: sections.envelopeByteCount,
    materialHash: sections.materialHash,
    ledger: sections.ledger,
    ledgerJson: canonicalJson(sections.ledger),
    ledgerHash: sections.ledgerHash
  };
  return { subject, sections, material, prepared: { ...material, ...prepareClaudeInvocation(subject, material) } };
}

describe("ReviewMaterialEnvelopeV1", () => {
  it("is the exact structure transmitted, and validates against its own versioned schema", () => {
    const { sections } = build();
    expect(sections.envelope.schemaVersion).toBe(REVIEW_MATERIAL_ENVELOPE_VERSION);
    expect(() => reviewMaterialEnvelopeSchema.parse(sections.envelope)).not.toThrow();
  });

  it("measures the EXACT canonical bytes of the complete envelope, not a sum of fragments", () => {
    const { sections } = build();
    expect(sections.envelopeByteCount).toBe(Buffer.byteLength(sections.envelopeJson, "utf8"));
    expect(sections.envelopeJson).toBe(canonicalJson(sections.envelope));
    expect(sections.materialHash).toBe(createHash("sha256").update(sections.envelopeJson, "utf8").digest("hex"));
  });

  it("measures the core's own outer framing rather than approximating it away", () => {
    const { sections } = build();
    expect(sections.ledger.coreCanonicalByteCount).toBe(Buffer.byteLength(canonicalJson(sections.core), "utf8"));
    // Section rows plus the core's own outer framing reconstruct the measured
    // whole exactly -- the two are reconciled, not merely coexisting.
    const sectionBytes = sections.ledger.sectionEntries
      .filter(entry => entry.category !== "REVIEWER_POLICY_PROMPT")
      .reduce((sum, entry) => sum + entry.serializedBytes, 0);
    expect(sectionBytes + sections.ledger.outerFramingByteCount).toBe(sections.ledger.coreCanonicalByteCount);
  });

  it("puts the evidence manifest, the provenance disclosure, and the ledger INSIDE what the model receives", () => {
    const { prepared } = build();
    // Not merely hashed into a binding the model cannot read: the reviewer can
    // see the accounting it is being held to.
    expect(prepared.materialCanonicalJson).toContain("evidenceManifest");
    expect(prepared.materialCanonicalJson).toContain("provenanceDisclosure");
    expect(prepared.materialCanonicalJson).toContain("coreCanonicalByteCount");
    expect(prepared.finalStdin).toContain("evidenceManifest");
    expect(prepared.finalStdin).toContain("provenanceDisclosure");
    expect(prepared.finalStdin).toContain("sectionEntries");
  });

  it("keeps the ledger non-self-referential: it never states its own size or hash", () => {
    const { sections } = build();
    const ledgerJson = canonicalJson(sections.ledger);
    expect(ledgerJson).not.toContain(sections.ledgerHash);
    expect(ledgerJson).not.toContain(String(sections.envelopeByteCount));
    // Building it twice from the same inputs is stable, which a value
    // containing its own measurement could not be.
    expect(canonicalJson(build().sections.ledger)).toBe(ledgerJson);
  });

  it("charges the reviewer policy prompt its exact UTF-8 byte count rather than a declared zero", () => {
    const { sections } = build();
    const entry = sections.ledger.sectionEntries.find(section => section.category === "REVIEWER_POLICY_PROMPT");
    expect(entry).toBeDefined();
    expect(entry!.serializedBytes).toBe(Buffer.byteLength(CLAUDE_PROMPT_POLICY, "utf8"));
  });

  it("renders the actual evidence content, not merely hashes of it", () => {
    const { sections } = build();
    expect(sections.envelopeJson).toContain("diff --git a/src/x.ts");
    expect(sections.envelopeJson).toContain("1 passed");
    expect(sections.envelopeJson).toContain("Do not touch auth.");
    expect(sections.envelopeJson).toContain("Tests pass.");
  });

  it("changes the material hash when any evidence changes", () => {
    expect(build({ executionSummary: "Did something else" }).sections.materialHash).not.toBe(build().sections.materialHash);
  });

  it("changes the material hash when only the reviewed request identity changes", () => {
    expect(build({ requestHash: "8".repeat(64) }).sections.materialHash).not.toBe(build().sections.materialHash);
  });

  // The envelope contains its own ledger, so a larger section also widens the
  // DECIMAL byte counts printed inside it. These bounds are therefore
  // "the escape cost, plus at most a few digits of ledger growth" -- stated
  // exactly rather than papered over with a loose `toBeGreaterThan`.
  const LEDGER_DIGIT_GROWTH = 16;

  it("charges JSON escaping: quotes and backslashes cost more than their raw length", () => {
    const plain = build({ executionSummary: "a".repeat(500) }).sections.envelopeByteCount;
    for (const character of ['"', "\\"]) {
      const escaped = build({ executionSummary: character.repeat(500) }).sections.envelopeByteCount;
      expect(escaped).toBeGreaterThanOrEqual(plain + 500);
      expect(escaped).toBeLessThanOrEqual(plain + 500 + LEDGER_DIGIT_GROWTH);
    }
  });

  it("accounts multibyte UTF-8 and emoji by byte length, not character length", () => {
    const ascii = build({ taskContext: "a".repeat(300) }).sections.envelopeByteCount;
    const multibyte = build({ taskContext: "€".repeat(300) }).sections.envelopeByteCount;
    const emoji = build({ taskContext: "🌍".repeat(300) }).sections.envelopeByteCount;
    expect(multibyte).toBeGreaterThanOrEqual(ascii + 600);
    expect(multibyte).toBeLessThanOrEqual(ascii + 600 + LEDGER_DIGIT_GROWTH);
    // A surrogate pair is 4 UTF-8 bytes and 2 UTF-16 code units: counting
    // characters would have charged 300 here, not 1,200.
    expect(emoji).toBeGreaterThanOrEqual(ascii + 900);
    expect(emoji).toBeLessThanOrEqual(ascii + 900 + LEDGER_DIGIT_GROWTH);
  });

  it("counts manifest overhead: more rendered fragments means a larger transmitted envelope", () => {
    const few = build({ taskConstraints: ["one"] }).sections;
    const many = build({ taskConstraints: Array.from({ length: 40 }, (_, index) => `constraint ${index}`) }).sections;
    expect(many.ledger.manifestByteCount).toBeGreaterThan(few.ledger.manifestByteCount);
    expect(many.envelopeByteCount).toBeGreaterThan(few.envelopeByteCount);
  });

  it("counts many small artifacts rather than treating a long manifest as free", () => {
    const manyArtifacts = Array.from({ length: 50 }, (_, index) => ({
      artifactId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      artifactType: "VERIFICATION", relativePath: `executions/session/part-${index}.json`,
      sha256: "b".repeat(64), byteCount: 1, truncated: false
    }));
    expect(build({ executionArtifactManifest: manyArtifacts }).sections.envelopeByteCount)
      .toBeGreaterThan(build().sections.envelopeByteCount + 50 * 100);
  });

  it("counts the reviewedRequestHash and schema framing it transmits", () => {
    const { sections } = build();
    expect(sections.envelopeJson).toContain(REQUEST_HASH);
    expect(sections.ledger.sectionEntries.some(entry => entry.sectionId === "coreFraming" && entry.serializedBytes > 0)).toBe(true);
  });
});

describe("prompt and stdin identity", () => {
  it("computes promptHash over the policy plus evidence block, excluding the echo lines", () => {
    const { prepared } = build();
    expect(prepared.promptHash).toBe(createHash("sha256").update(prepared.finalPrompt, "utf8").digest("hex"));
    expect(prepared.finalPrompt).not.toContain("promptHash:");
    expect(prepared.finalStdin).toContain(`promptHash: ${prepared.promptHash}`);
  });

  it("echoes requestHash and materialHash verbatim for the model to copy", () => {
    const { subject, prepared } = build();
    expect(prepared.finalStdin).toContain(`requestHash: ${subject.requestHash}`);
    expect(prepared.finalStdin).toContain(`materialHash: ${prepared.materialHash}`);
  });

  it("measures the prompt and stdin from the exact strings that were built, including every delimiter and the final newline", () => {
    const { prepared } = build();
    expect(prepared.finalPromptByteCount).toBe(Buffer.byteLength(prepared.finalPrompt, "utf8"));
    expect(prepared.finalStdinByteCount).toBe(Buffer.byteLength(prepared.finalStdin, "utf8"));
    expect(prepared.finalStdinHash).toBe(createHash("sha256").update(prepared.finalStdin, "utf8").digest("hex"));
    expect(prepared.policyPromptByteCount).toBe(Buffer.byteLength(CLAUDE_PROMPT_POLICY, "utf8"));
    expect(prepared.promptPolicyVersion).toBe(CLAUDE_PROMPT_POLICY_VERSION);
  });

  it("hashes the same representation it sends: the material inside stdin is byte-identical to the measured envelope", () => {
    const { prepared } = build();
    expect(prepared.finalStdin).toContain(prepared.materialCanonicalJson);
    expect(prepared.materialByteCount).toBe(Buffer.byteLength(prepared.materialCanonicalJson, "utf8"));
  });

  it("counts the manifest, ledger, and policy prompt bytes, none of which the original accounting included", () => {
    const { prepared } = build();
    expect(prepared.promptAccounting.manifestJsonBytes).toBeGreaterThan(0);
    expect(prepared.promptAccounting.budgetLedgerJsonBytes).toBeGreaterThan(0);
    expect(prepared.promptAccounting.policyPromptBytes).toBe(Buffer.byteLength(CLAUDE_PROMPT_POLICY, "utf8"));
  });

  it("is built exactly once: preparing twice from the same material yields identical bytes and hashes", () => {
    const { subject, material } = build();
    const first = prepareClaudeInvocation(subject, material);
    const second = prepareClaudeInvocation(subject, material);
    expect(second.finalStdin).toBe(first.finalStdin);
    expect(second.finalStdinHash).toBe(first.finalStdinHash);
    expect(second.promptHash).toBe(first.promptHash);
    expect(second.promptAccounting).toEqual(first.promptAccounting);
  });
});

describe("prompt and stdin budget enforcement", () => {
  const budget = AUTHORITATIVE_REVIEW_MATERIAL_BUDGET;
  const config = { maximumInputBytes: 2_000_000, materialBudgetVersion: "material-budget-v1" } as unknown as Parameters<typeof assertPromptWithinBudget>[1];

  function preparedWith(promptBytes: number, stdinBytes: number, materialBytes = 1_000) {
    const { prepared } = build();
    return {
      ...prepared,
      materialByteCount: materialBytes,
      promptAccounting: { ...prepared.promptAccounting, finalPromptBytes: promptBytes, finalStdinBytes: stdinBytes }
    };
  }

  it("accepts a prompt at exactly maxPromptBytes", () => {
    expect(() => assertPromptWithinBudget(preparedWith(budget.maxPromptBytes, budget.maxPromptBytes), config)).not.toThrow();
  });

  it("rejects a prompt of maxPromptBytes + 1 even though it is still far below the stdin cap", () => {
    const prepared = preparedWith(budget.maxPromptBytes + 1, budget.maxPromptBytes + 1);
    expect(prepared.promptAccounting.finalStdinBytes).toBeLessThan(budget.maxFinalStdinBytes);
    expect(() => assertPromptWithinBudget(prepared, config)).toThrow(/maximum prompt size/);
  });

  it("rejects stdin of maxFinalStdinBytes + 1", () => {
    expect(() => assertPromptWithinBudget(preparedWith(1_000, budget.maxFinalStdinBytes + 1), config)).toThrow(/maximum stdin size/);
  });

  it("accepts stdin at exactly maxFinalStdinBytes", () => {
    expect(() => assertPromptWithinBudget(preparedWith(1_000, budget.maxFinalStdinBytes), config)).not.toThrow();
  });

  it("rejects material larger than the request's own bound maximumInputBytes", () => {
    const narrow = { maximumInputBytes: 100, materialBudgetVersion: "material-budget-v1" } as unknown as typeof config;
    expect(() => assertPromptWithinBudget(preparedWith(1_000, 1_000, 101), narrow)).toThrow(/maximumInputBytes/);
  });
});
