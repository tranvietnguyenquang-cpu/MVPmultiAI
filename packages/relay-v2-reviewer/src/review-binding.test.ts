import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AUTHORITATIVE_REVIEW_MATERIAL_BUDGET, MATERIAL_BUDGET_POLICY_VERSION, canonicalJson, hashTaskSpec, untruncatedProvenance, type LogProvenance, type NormalizedTaskSpec } from "@project-relay/relay-v2-domain";
import { completeLogProvenance, emptyStreamCapture, validatedLogPart } from "./evidence-test-fixtures.js";
import {
  checkAuthoritativeMaterialPolicy,
  checkCriticalRedactionCollapse,
  checkRenderedDiffCoverage,
  checkGitEvidenceIntegrity, checkVerificationEvidenceIntegrity,
  checkVerificationTruncationSafety,
  computeCanonicalTaskSpecHash, computeRequestHash, computeReviewInputHash, computeTaskNormalizedSpecHash,
  EMPTY_EXECUTION_LOG_EVIDENCE,
  EVIDENCE_CATEGORY_TRUNCATION_POLICY,
  reviewInputCapsuleObjectSchema, reviewInputCapsuleSchema, sha256Hex, summarizeBaselineGitEvidence, summarizeExecutionLogEvidence, summarizeFinalGitEvidence, summarizeVerificationEvidence,
  verifyCapsuleIntegrity, type ReviewInputCapsule, type ReviewVerificationEvidence
} from "./review-binding.js";

const HASH = "a".repeat(64);

function capsule(overrides: Partial<ReviewInputCapsule> = {}): ReviewInputCapsule {
  return {
    reviewRequestId: "00000000-0000-4000-8000-000000000001",
    executionSessionId: "00000000-0000-4000-8000-000000000002",
    projectId: "00000000-0000-4000-8000-000000000003",
    taskId: "00000000-0000-4000-8000-000000000004",
    reviewerId: "fake-reviewer",
    reviewAuthority: "DIAGNOSTIC",
    diagnostic: true,
    approvalId: "00000000-0000-4000-8000-000000000005",
    approvalStatus: "APPROVED",
    approvedReviewer: "CLAUDE",
    taskSelectedReviewer: "CLAUDE",
    executionExecutorId: "fake",
    taskTitle: "Do the thing",
    taskObjective: "Make the thing happen",
    taskContext: "Some context",
    taskSpecHash: HASH,
    canonicalTaskSpecHash: HASH,
    taskNormalizedSpecHash: HASH,
    approvalSnapshotHash: HASH,
    executionStatus: "SUCCEEDED",
    executionResultStatus: "succeeded",
    executionSummary: "It worked.",
    executionSummaryHash: HASH,
    executionCapsuleHash: HASH,
    executionCapsuleJsonHash: HASH,
    baselineGitEvidenceHash: HASH,
    finalGitEvidenceHash: HASH,
    verificationResultsHash: HASH,
    executionArtifactSetHash: HASH,
    finalBranch: "main",
    finalHead: "deadbeef",
    requestedAt: "2026-08-02T00:00:00.000Z",
    reviewPolicyVersion: "2.3A-v1",
    taskConstraints: [],
    acceptanceCriteria: [],
    approvedExecutorSelection: "FAKE",
    approvedModel: "AUTO",
    approvedEffort: "AUTO",
    approvedVerificationOperations: [],
    baselineGitEvidence: { available: false, branch: "", head: "", dirty: false, changedFiles: [], diffPreview: "", diffTruncated: false, diffOmittedForSensitivePaths: false },
    finalGitEvidence: { available: false, branch: "", head: "", dirty: false, changedFiles: [], diffPreview: "", diffTruncated: false, diffOmittedForSensitivePaths: false },
    verificationEvidence: [],
    executionArtifactManifest: [],
    executionLogEvidence: EMPTY_EXECUTION_LOG_EVIDENCE,
    ...overrides
  };
}

const ALL_FIELDS: ReadonlyArray<readonly [keyof ReviewInputCapsule, unknown]> = [
  ["reviewRequestId", "00000000-0000-4000-8000-000000000099"],
  ["executionSessionId", "00000000-0000-4000-8000-000000000099"],
  ["projectId", "00000000-0000-4000-8000-000000000099"],
  ["taskId", "00000000-0000-4000-8000-000000000099"],
  ["reviewerId", "some-other-reviewer"],
  ["reviewAuthority", "AUTHORITATIVE"],
  ["diagnostic", false],
  ["approvalId", "00000000-0000-4000-8000-000000000099"],
  ["approvalStatus", "INVALIDATED"],
  ["approvedReviewer", "CODEX"],
  ["taskSelectedReviewer", "CODEX"],
  ["executionExecutorId", "codex-cli"],
  ["taskTitle", "A different title"],
  ["taskObjective", "A different objective"],
  ["taskContext", "Different context"],
  ["taskSpecHash", "b".repeat(64)],
  ["canonicalTaskSpecHash", "b".repeat(64)],
  ["taskNormalizedSpecHash", "b".repeat(64)],
  ["approvalSnapshotHash", "b".repeat(64)],
  ["executionStatus", "FAILED"],
  ["executionResultStatus", "failed"],
  ["executionSummary", "A different summary."],
  ["executionSummaryHash", "b".repeat(64)],
  ["executionCapsuleHash", "b".repeat(64)],
  ["executionCapsuleJsonHash", "b".repeat(64)],
  ["baselineGitEvidenceHash", "b".repeat(64)],
  ["finalGitEvidenceHash", "b".repeat(64)],
  ["verificationResultsHash", "b".repeat(64)],
  ["executionArtifactSetHash", "b".repeat(64)],
  ["finalBranch", "other-branch"],
  ["finalHead", "cafebabe"],
  ["requestedAt", "2026-08-02T00:00:01.000Z"],
  ["reviewPolicyVersion", "9.9Z-v1"],
  ["taskConstraints", ["A new constraint."]],
  ["acceptanceCriteria", ["A new acceptance criterion."]],
  ["approvedExecutorSelection", "CODEX"],
  ["approvedModel", "gpt-5"],
  ["approvedEffort", "HIGH"],
  ["approvedVerificationOperations", ["NPM_TEST"]],
  ["baselineGitEvidence", { available: true, branch: "other", head: "b".repeat(40), dirty: true, changedFiles: [], diffPreview: "diff", diffTruncated: false, diffOmittedForSensitivePaths: false }],
  ["finalGitEvidence", { available: true, branch: "other", head: "b".repeat(40), dirty: true, changedFiles: [], diffPreview: "diff", diffTruncated: false, diffOmittedForSensitivePaths: false }],
  ["verificationEvidence", [{
    operation: "NPM_TEST", displayCommand: "npm test", passed: true, exitCode: 0, timedOut: false, cancelled: false,
    summary: "ok", stdoutPreview: "", stdoutTruncated: false, stderrPreview: "", stderrTruncated: false,
    runnerOutputTruncated: false, runnerStdoutBytes: 0, runnerStderrBytes: 0,
    stdoutCapture: emptyStreamCapture("stdout"), stderrCapture: emptyStreamCapture("stderr"),
    startedAt: "", finishedAt: "", resultHash: "e".repeat(64)
  }]],
  ["executionArtifactManifest", [{ artifactId: "00000000-0000-4000-8000-0000000000c1", artifactType: "PATCH", relativePath: "x", sha256: "b".repeat(64), byteCount: 1, truncated: false }]],
  ["executionLogEvidence", {
    available: true, preview: "log line", producerProvenance: null, producerTruncated: false,
    sourceByteCount: 8, includedContentSha256: "c".repeat(64),
    reviewerIncludedByteCount: 8, reviewerOmittedByteCount: 0, reviewerMarkerByteCount: 0,
    reviewerFinalRenderedByteCount: 8, reviewerRenderedSha256: "d".repeat(64),
    reviewerTruncated: false, reviewerTruncationMethod: "NONE" as const,
    reviewerIncludedRecordCount: 1, reviewerOmittedRecordCount: 0, anyTruncation: false
  }]
];

describe("review input hash", () => {
  it("is deterministic for identical bound input", () => {
    expect(computeReviewInputHash(capsule())).toBe(computeReviewInputHash(capsule()));
  });

  it("produces a 64-character hex digest", () => {
    expect(computeReviewInputHash(capsule())).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each(ALL_FIELDS)("changing %s changes the review input hash", (field, value) => {
    const original = computeReviewInputHash(capsule());
    const changed = computeReviewInputHash(capsule({ [field]: value } as Partial<ReviewInputCapsule>));
    expect(changed).not.toBe(original);
  });

  it("covers every field declared on the schema (no field silently excluded from hashing)", () => {
    const declaredFields = Object.keys(reviewInputCapsuleObjectSchema.shape);
    const testedFields = ALL_FIELDS.map(([field]) => field);
    expect(new Set(testedFields)).toEqual(new Set(declaredFields));
  });

  it("rejects a duplicate execution artifact manifest entry", () => {
    const duplicateArtifact = { artifactId: "00000000-0000-4000-8000-0000000000a1", artifactType: "PATCH", relativePath: "x", sha256: "b".repeat(64), byteCount: 1, truncated: false };
    expect(() => reviewInputCapsuleSchema.parse(capsule({ executionArtifactManifest: [duplicateArtifact, duplicateArtifact] }))).toThrow();
  });

  it("rejects a malformed capsule", () => {
    expect(() => reviewInputCapsuleSchema.parse(capsule({ taskSpecHash: "not-a-hash" }))).toThrow();
  });
});

describe("request hash", () => {
  const reviewInputHash = computeReviewInputHash(capsule());
  const identity = {
    reviewInputHash, reviewerConfigHash: "c".repeat(64), reviewerId: "fake-reviewer" as const,
    reviewAuthority: "DIAGNOSTIC" as const, requestedBy: "tester", attempt: 0, reviewPolicyVersion: "2.3A-v1"
  };

  it("is deterministic", () => {
    expect(computeRequestHash(identity)).toBe(computeRequestHash(identity));
  });

  it.each([
    ["reviewInputHash", "b".repeat(64)],
    ["reviewerConfigHash", "d".repeat(64)],
    ["reviewerId", "some-other-reviewer"],
    ["reviewAuthority", "AUTHORITATIVE"],
    ["requestedBy", "other-actor"],
    ["attempt", 1],
    ["reviewPolicyVersion", "9.9Z-v1"]
  ] as const)("changing %s changes the request hash", (field, value) => {
    const base = computeRequestHash(identity);
    const changed = computeRequestHash({ ...identity, [field]: value } as typeof identity);
    expect(changed).not.toBe(base);
  });
});

function spec(overrides: Partial<NormalizedTaskSpec["task"]> = {}): NormalizedTaskSpec {
  return {
    version: 1,
    project: { name: "Review Test" },
    task: { title: "Review fake work", objective: "Exercise binding", taskType: "IMPLEMENTATION", complexity: "NORMAL", context: "", ...overrides },
    constraints: [],
    acceptanceCriteria: ["Done"],
    execution: { executor: "FAKE", model: "AUTO", effort: "MEDIUM", reviewer: "CLAUDE", requireApproval: true },
    permissions: [{ permission: "WORKSPACE_WRITE", value: false }]
  };
}

describe("computeCanonicalTaskSpecHash", () => {
  it("reproduces hashTaskSpec over the approval snapshot's embedded spec", () => {
    const normalized = spec();
    const approvedSpecJson = canonicalJson({ specHash: hashTaskSpec(normalized), task: normalized });
    expect(computeCanonicalTaskSpecHash(approvedSpecJson)).toBe(hashTaskSpec(normalized));
  });

  it("changes when the embedded spec content changes", () => {
    const first = canonicalJson({ specHash: "x", task: spec() });
    const second = canonicalJson({ specHash: "x", task: spec({ title: "A different title" }) });
    expect(computeCanonicalTaskSpecHash(first)).not.toBe(computeCanonicalTaskSpecHash(second));
  });
});

describe("computeTaskNormalizedSpecHash", () => {
  it("reproduces hashTaskSpec over the task's current normalizedSpecJson", () => {
    const normalized = spec();
    expect(computeTaskNormalizedSpecHash(canonicalJson(normalized))).toBe(hashTaskSpec(normalized));
  });

  it("changes when normalizedSpecJson changes", () => {
    expect(computeTaskNormalizedSpecHash(canonicalJson(spec())))
      .not.toBe(computeTaskNormalizedSpecHash(canonicalJson(spec({ objective: "A different objective" }))));
  });
});

describe("sha256Hex", () => {
  it("hashes deterministically", () => {
    expect(sha256Hex("relay")).toBe(sha256Hex("relay"));
    expect(sha256Hex("relay")).not.toBe(sha256Hex("relay2"));
  });
});

describe("verifyCapsuleIntegrity", () => {
  it("accepts the no-capsule fake-executor case", () => {
    expect(verifyCapsuleIntegrity("{}", null)).toBe(true);
  });

  it("rejects a non-empty capsuleJson when no capsuleHash column is stored", () => {
    expect(verifyCapsuleIntegrity(canonicalJson({ a: 1 }), null)).toBe(false);
  });

  it("accepts a self-consistent capsule", () => {
    const withoutHash = { sessionId: "s1", taskId: "t1" };
    const capsuleHash = sha256Hex(canonicalJson(withoutHash));
    const capsuleJson = canonicalJson({ ...withoutHash, capsuleHash });
    expect(verifyCapsuleIntegrity(capsuleJson, capsuleHash)).toBe(true);
  });

  it("rejects when the embedded capsuleHash does not match the capsule body", () => {
    const capsuleJson = canonicalJson({ sessionId: "s1", capsuleHash: "b".repeat(64) });
    expect(verifyCapsuleIntegrity(capsuleJson, "b".repeat(64))).toBe(false);
  });

  it("rejects when the stored column disagrees with an otherwise self-consistent capsule", () => {
    const withoutHash = { sessionId: "s1" };
    const capsuleHash = sha256Hex(canonicalJson(withoutHash));
    const capsuleJson = canonicalJson({ ...withoutHash, capsuleHash });
    expect(verifyCapsuleIntegrity(capsuleJson, "c".repeat(64))).toBe(false);
  });

  it("rejects malformed JSON", () => {
    expect(verifyCapsuleIntegrity("not-json", "a".repeat(64))).toBe(false);
  });
});

/** Builds a self-consistent, strictly-valid persisted GitEvidence object exactly matching WorkspaceEvidenceService.capture's shape (see workspace-evidence.ts). */
function validGitEvidence(overrides: Record<string, unknown> = {}) {
  const withoutHash = {
    repositoryRoot: "C:/repo", branch: "main", head: "a".repeat(40), dirty: false,
    status: [], stagedCount: 0, unstagedCount: 0, untrackedCount: 0,
    patchPreview: "", patchSha256: sha256Hex(""), patchTruncated: false, patchProvenance: untruncatedProvenance(""), patchOmittedForSensitivePaths: false,
    ...overrides
  };
  return { ...withoutHash, capturedAt: "2026-08-03T00:00:00.000Z", evidenceHash: sha256Hex(canonicalJson(withoutHash)) };
}

/** Builds a self-consistent `{ evidence, delta }` envelope exactly matching what ExecutionEngine persists into `finalEvidenceJson`. */
function validFinalGitEnvelope(evidenceOverrides: Record<string, unknown> = {}, deltaOverrides: Record<string, unknown> = {}) {
  const evidence = validGitEvidence(evidenceOverrides);
  const delta = {
    baselineHash: "b".repeat(64), finalHash: evidence.evidenceHash, changedFiles: [],
    headChanged: false, branchChanged: false, preExistingChangesDestroyed: [], preExistingChangesHidden: [],
    unaccountedPreExistingPaths: [], stashChanged: false, forbiddenGitMutationSuspected: false,
    ...deltaOverrides
  };
  return { evidence, delta };
}

/** Builds a self-consistent persisted VerificationResult exactly matching VerificationCatalogRunner's shape (see verification-catalog.ts). */
function validVerificationResult(overrides: Record<string, unknown> = {}) {
  const withoutHash = {
    operation: "NPM_TEST", displayCommand: "npm test", passed: true, exitCode: 0, timedOut: false, cancelled: false,
    summary: "npm test passed.",
    stdoutPreview: "", stdoutTruncated: false, stdoutProvenance: untruncatedProvenance(""),
    stderrPreview: "", stderrTruncated: false, stderrProvenance: untruncatedProvenance(""),
    runnerOutputTruncated: false, runnerStdoutBytes: 0, runnerStderrBytes: 0,
    stdoutCapture: emptyStreamCapture("stdout"), stderrCapture: emptyStreamCapture("stderr"),
    startedAt: "2026-08-03T00:00:00.000Z", finishedAt: "2026-08-03T00:00:01.000Z",
    ...overrides
  };
  return { ...withoutHash, resultHash: sha256Hex(canonicalJson(withoutHash)) };
}

describe("checkGitEvidenceIntegrity", () => {
  it("accepts the well-formed-empty '{}' case", () => {
    expect(checkGitEvidenceIntegrity("{}", "Baseline", "baseline")).toEqual({ ok: true });
  });

  it("accepts strictly well-formed, self-consistent baseline evidence", () => {
    expect(checkGitEvidenceIntegrity(canonicalJson(validGitEvidence()), "Baseline", "baseline")).toEqual({ ok: true });
  });

  it("accepts strictly well-formed, self-consistent final evidence", () => {
    expect(checkGitEvidenceIntegrity(canonicalJson(validFinalGitEnvelope()), "Final", "final")).toEqual({ ok: true });
  });

  it("rejects malformed (non-parseable) non-empty JSON as a hard failure, never as available:false", () => {
    const result = checkGitEvidenceIntegrity("{not valid json", "Baseline", "baseline");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not valid JSON/i);
  });

  it("rejects a JSON array (wrong shape) as a hard failure", () => {
    const result = checkGitEvidenceIntegrity("[]", "Final", "final");
    expect(result.ok).toBe(false);
  });

  it("rejects a bare JSON primitive (wrong shape) as a hard failure", () => {
    expect(checkGitEvidenceIntegrity("42", "Baseline", "baseline").ok).toBe(false);
    expect(checkGitEvidenceIntegrity("null", "Baseline", "baseline").ok).toBe(false);
    expect(checkGitEvidenceIntegrity('"a string"', "Baseline", "baseline").ok).toBe(false);
  });

  it("rejects valid JSON with the wrong shape -- e.g. { unexpected: true } -- rather than treating it as available/empty", () => {
    const result = checkGitEvidenceIntegrity(canonicalJson({ unexpected: true }), "Baseline", "baseline");
    expect(result.ok).toBe(false);
  });

  it("rejects well-formed JSON missing required fields (branch/head)", () => {
    const result = checkGitEvidenceIntegrity(canonicalJson({ evidence: { branch: "main", head: "abc" } }), "Final", "final");
    expect(result.ok).toBe(false);
  });

  it("rejects an unknown/extra field on an otherwise valid evidence object", () => {
    const result = checkGitEvidenceIntegrity(canonicalJson({ ...validGitEvidence(), unknownField: "x" }), "Baseline", "baseline");
    expect(result.ok).toBe(false);
  });

  it("rejects a malformed changed-file entry (wrong field type)", () => {
    const envelope = validFinalGitEnvelope({}, { changedFiles: [{ path: "src/x.ts", baselineSha256: null, finalSha256: null, preExisting: "yes", binary: null }] });
    expect(checkGitEvidenceIntegrity(canonicalJson(envelope), "Final", "final").ok).toBe(false);
  });

  it("rejects a duplicate/conflicting changed path in the delta", () => {
    const changedFiles = [
      { path: "src/x.ts", baselineSha256: null, finalSha256: "a".repeat(64), preExisting: false, binary: false },
      { path: "src/x.ts", baselineSha256: "a".repeat(64), finalSha256: null, preExisting: true, binary: false }
    ];
    const envelope = validFinalGitEnvelope({}, { changedFiles });
    expect(checkGitEvidenceIntegrity(canonicalJson(envelope), "Final", "final").ok).toBe(false);
  });

  it("rejects a traversal path in status/changedFiles", () => {
    const baseline = validGitEvidence({ status: [{ path: "../../etc/passwd", indexStatus: " ", worktreeStatus: "M", staged: false, unstaged: true, untracked: false, sensitive: false, contentSha256: null, byteCount: null, binary: null }] });
    expect(checkGitEvidenceIntegrity(canonicalJson(baseline), "Baseline", "baseline").ok).toBe(false);
  });

  it("rejects evidence whose self-referential evidenceHash was tampered with", () => {
    const tampered = { ...validGitEvidence(), branch: "some-other-branch" };
    expect(checkGitEvidenceIntegrity(canonicalJson(tampered), "Baseline", "baseline").ok).toBe(false);
  });

  it("rejects a final envelope whose delta.finalHash does not match its own embedded evidence", () => {
    const envelope = validFinalGitEnvelope();
    const tampered = { ...envelope, delta: { ...envelope.delta, finalHash: "f".repeat(64) } };
    expect(checkGitEvidenceIntegrity(canonicalJson(tampered), "Final", "final").ok).toBe(false);
  });
});

describe("summarizeBaselineGitEvidence / summarizeFinalGitEvidence", () => {
  it("summarizes the well-formed-empty case as unavailable", () => {
    expect(summarizeBaselineGitEvidence("{}").available).toBe(false);
    expect(summarizeFinalGitEvidence("{}").available).toBe(false);
  });

  it("summarizes strictly valid evidence as available with the real content", () => {
    const summary = summarizeBaselineGitEvidence(canonicalJson(validGitEvidence({ branch: "feature/x", dirty: true })));
    expect(summary).toMatchObject({ available: true, branch: "feature/x", dirty: true });
  });

  it("throws (never silently degrades to available:false) on malformed evidence -- callers must gate with checkGitEvidenceIntegrity first", () => {
    expect(() => summarizeBaselineGitEvidence(canonicalJson({ unexpected: true }))).toThrow();
    expect(() => summarizeFinalGitEvidence(canonicalJson({ unexpected: true }))).toThrow();
  });

  it("derives added/modified/deleted status correctly for final evidence changed files", () => {
    const envelope = validFinalGitEnvelope({}, { changedFiles: [
      { path: "new.ts", baselineSha256: null, finalSha256: "a".repeat(64), preExisting: false, binary: false },
      { path: "removed.ts", baselineSha256: "a".repeat(64), finalSha256: null, preExisting: true, binary: false },
      { path: "edited.ts", baselineSha256: "a".repeat(64), finalSha256: "b".repeat(64), preExisting: true, binary: false }
    ] });
    const summary = summarizeFinalGitEvidence(canonicalJson(envelope));
    expect(summary.changedFiles).toEqual([
      { path: "new.ts", status: "added", binary: false },
      { path: "removed.ts", status: "deleted", binary: false },
      { path: "edited.ts", status: "modified", binary: false }
    ]);
  });
});

describe("checkVerificationEvidenceIntegrity", () => {
  it("accepts the well-formed-empty '[]' case", () => {
    expect(checkVerificationEvidenceIntegrity("[]")).toEqual({ ok: true });
  });

  it("accepts a strictly well-formed, self-consistent non-empty array", () => {
    expect(checkVerificationEvidenceIntegrity(canonicalJson([validVerificationResult()]))).toEqual({ ok: true });
  });

  it("rejects malformed (non-parseable) non-empty JSON as a hard failure, never as an empty result set", () => {
    const result = checkVerificationEvidenceIntegrity("{not valid json");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not valid JSON/i);
  });

  it("rejects a JSON object (wrong shape, not an array) as a hard failure", () => {
    const result = checkVerificationEvidenceIntegrity(canonicalJson({ operation: "NPM_TEST" }));
    expect(result.ok).toBe(false);
  });

  it("rejects an unknown verification operation", () => {
    expect(checkVerificationEvidenceIntegrity(canonicalJson([validVerificationResult({ operation: "TYPECHECK" })])).ok).toBe(false);
  });

  it("rejects PASS with a nonzero exit code", () => {
    expect(checkVerificationEvidenceIntegrity(canonicalJson([validVerificationResult({ passed: true, exitCode: 1 })])).ok).toBe(false);
  });

  it("rejects a missing/malformed resultHash", () => {
    expect(checkVerificationEvidenceIntegrity(canonicalJson([{ ...validVerificationResult(), resultHash: "" }])).ok).toBe(false);
  });

  it("rejects a result whose resultHash was tampered with (content edited without recomputing the hash)", () => {
    const tampered = { ...validVerificationResult(), summary: "a different summary" };
    expect(checkVerificationEvidenceIntegrity(canonicalJson([tampered])).ok).toBe(false);
  });

  it("accepts legitimate empty stdout/stderr represented explicitly with their own valid resultHash", () => {
    expect(checkVerificationEvidenceIntegrity(canonicalJson([validVerificationResult({ stdoutPreview: "", stderrPreview: "" })])).ok).toBe(true);
  });
});

describe("summarizeVerificationEvidence", () => {
  it("summarizes the well-formed-empty case as an empty array", () => {
    expect(summarizeVerificationEvidence("[]")).toEqual([]);
  });

  it("summarizes a valid result, echoing its resultHash", () => {
    // The reviewer-facing projection carries the bounded previews and their
    // truncation flags; the producer's byte-level provenance stays on the
    // persisted result, where the artifact-side truncation policy reads it.
    const { stdoutProvenance, stderrProvenance, ...projected } = validVerificationResult();
    expect(summarizeVerificationEvidence(canonicalJson([{ ...projected, stdoutProvenance, stderrProvenance }]))).toEqual([projected]);
  });

  it("throws (never silently degrades to an empty array) on malformed verification results", () => {
    expect(() => summarizeVerificationEvidence(canonicalJson({ operation: "NPM_TEST" }))).toThrow();
  });
});

// ============================================================================
// Milestone 2.3B fourth corrective pass -- category-specific truncation
// policy, total material byte budget, and execution-log evidence.
// ============================================================================

/** A stable request identity for material tests; the envelope embeds it, so it must be a real sha256-shaped value. */
const REQUEST_HASH = "9".repeat(64);

function verificationEntry(overrides: Partial<ReviewVerificationEvidence> = {}): ReviewVerificationEvidence {
  return {
    operation: "NPM_TEST", displayCommand: "npm test", passed: true, exitCode: 0, timedOut: false, cancelled: false,
    summary: "ok", stdoutPreview: "", stdoutTruncated: false, stderrPreview: "", stderrTruncated: false,
    runnerOutputTruncated: false, runnerStdoutBytes: 0, runnerStderrBytes: 0,
    stdoutCapture: emptyStreamCapture("stdout"), stderrCapture: emptyStreamCapture("stderr"),
    startedAt: "2026-08-03T00:00:00.000Z", finishedAt: "2026-08-03T00:00:01.000Z", resultHash: "e".repeat(64),
    ...overrides
  };
}

/** A realistic AUTHORITATIVE capsule within every material budget category, for tests to override one field at a time. */
function authoritativeCapsule(overrides: Partial<ReviewInputCapsule> = {}): ReviewInputCapsule {
  return capsule({
    reviewAuthority: "AUTHORITATIVE", diagnostic: false, executionExecutorId: "codex-cli",
    finalGitEvidence: {
      available: true, branch: "main", head: "b".repeat(40), dirty: true,
      changedFiles: [{ path: "src/x.ts", status: "modified", binary: false }],
      diffPreview: "diff --git a/src/x.ts b/src/x.ts\n+hello\n", diffTruncated: false, diffOmittedForSensitivePaths: false
    },
    verificationEvidence: [verificationEntry()],
    executionLogEvidence: {
      available: true, preview: "{}", producerProvenance: null, producerTruncated: false,
      sourceByteCount: 2, includedContentSha256: sha256Hex("{}"),
      reviewerIncludedByteCount: 2, reviewerOmittedByteCount: 0, reviewerMarkerByteCount: 0,
      reviewerFinalRenderedByteCount: 2, reviewerRenderedSha256: sha256Hex("{}"),
      reviewerTruncated: false, reviewerTruncationMethod: "NONE",
      reviewerIncludedRecordCount: 0, reviewerOmittedRecordCount: 0, anyTruncation: false
    },
    ...overrides
  });
}

describe("EVIDENCE_CATEGORY_TRUNCATION_POLICY", () => {
  it("classifies every required category from the schema's own field bounds as NON_TRUNCATABLE_CRITICAL, TRUNCATABLE_CRITICAL_WITH_DISCLOSURE, or OPTIONAL", () => {
    expect(EVIDENCE_CATEGORY_TRUNCATION_POLICY.APPROVED_SPEC!.truncationClass).toBe("NON_TRUNCATABLE_CRITICAL");
    expect(EVIDENCE_CATEGORY_TRUNCATION_POLICY.CHANGED_FILE_LIST!.truncationClass).toBe("NON_TRUNCATABLE_CRITICAL");
    expect(EVIDENCE_CATEGORY_TRUNCATION_POLICY.FINAL_GIT_DIFF!.truncationClass).toBe("TRUNCATABLE_CRITICAL_WITH_DISCLOSURE");
    expect(EVIDENCE_CATEGORY_TRUNCATION_POLICY.VERIFICATION_STDOUT!.truncationClass).toBe("TRUNCATABLE_CRITICAL_WITH_DISCLOSURE");
    expect(EVIDENCE_CATEGORY_TRUNCATION_POLICY.EXECUTION_LOG!.truncationClass).toBe("OPTIONAL");
    expect(EVIDENCE_CATEGORY_TRUNCATION_POLICY.EXECUTION_LOG!.blocksReviewWhenImpermissiblyTruncated).toBe(false);
  });
});

describe("a truncated approved task spec is rejected (schema-enforced, never silently cut)", () => {
  it("rejects a task objective beyond its schema bound rather than truncating it", () => {
    expect(() => reviewInputCapsuleSchema.parse(authoritativeCapsule({ taskObjective: "x".repeat(10_001) }))).toThrow();
  });

  it("rejects an acceptance-criteria array beyond its schema bound rather than truncating it", () => {
    expect(() => reviewInputCapsuleSchema.parse(authoritativeCapsule({ acceptanceCriteria: Array.from({ length: 101 }, () => "x") }))).toThrow();
  });
});

describe("a truncated changed-file list is rejected (schema-enforced, never silently cut)", () => {
  it("rejects a changedFiles array beyond its schema bound rather than truncating it", () => {
    const tooMany = Array.from({ length: 501 }, (_, index) => ({ path: `src/file-${index}.ts`, status: "modified" as const, binary: false }));
    expect(() => reviewInputCapsuleSchema.parse(authoritativeCapsule({ finalGitEvidence: { ...authoritativeCapsule().finalGitEvidence, changedFiles: tooMany } }))).toThrow();
  });
});

describe("checkRenderedDiffCoverage", () => {
  const files = [{ path: "src/a.ts" }, { path: "src/b.ts" }];

  it("accepts a non-truncated diff regardless of changed-file coverage", () => {
    expect(checkRenderedDiffCoverage("", files, false)).toEqual({ ok: true });
  });

  it("accepts a truncated diff whose RENDERED text still evidences every changed file", () => {
    const rendered = "diff --git a/src/a.ts b/src/a.ts\n+x\ndiff --git a/src/b.ts b/src/b.ts\n+y\n";
    expect(checkRenderedDiffCoverage(rendered, files, true)).toEqual({ ok: true });
  });

  it("rejects a truncated diff that omits evidence for a changed file", () => {
    const result = checkRenderedDiffCoverage("diff --git a/src/a.ts b/src/a.ts\n+x\n", files, true);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("src/b.ts");
  });

  it("checks the text that was actually rendered, not the pre-truncation source", () => {
    // Coverage that exists only before reviewer-side bounding must not count:
    // the reader sees the rendered string, so that is what is checked.
    const preTruncation = "diff --git a/src/a.ts b/src/a.ts\ndiff --git a/src/b.ts b/src/b.ts\n";
    const rendered = preTruncation.slice(0, 34);
    expect(checkRenderedDiffCoverage(preTruncation, files, true)).toEqual({ ok: true });
    expect(checkRenderedDiffCoverage(rendered, files, true).ok).toBe(false);
  });
});

describe("checkVerificationTruncationSafety", () => {
  it("accepts a passing verification result even when truncated (not failure-critical)", () => {
    expect(checkVerificationTruncationSafety([verificationEntry({ passed: true, stdoutTruncated: true })])).toEqual({ ok: true });
  });

  it("accepts a failed verification result whose output was not truncated", () => {
    expect(checkVerificationTruncationSafety([verificationEntry({ passed: false, stdoutTruncated: false, stderrTruncated: false })])).toEqual({ ok: true });
  });

  it("rejects a failed verification result whose stdout was truncated (failure-relevant tail cannot be proven preserved)", () => {
    const result = checkVerificationTruncationSafety([verificationEntry({ passed: false, stdoutTruncated: true })]);
    expect(result.ok).toBe(false);
  });

  it("rejects a failed verification result whose stderr was truncated", () => {
    const result = checkVerificationTruncationSafety([verificationEntry({ passed: false, stderrTruncated: true })]);
    expect(result.ok).toBe(false);
  });
});

describe("checkCriticalRedactionCollapse", () => {
  it("accepts ordinary critical-field text with no secret-shaped content", () => {
    expect(checkCriticalRedactionCollapse(authoritativeCapsule())).toEqual({ ok: true });
  });

  it("accepts critical text containing a small redacted secret alongside substantial ordinary content", () => {
    const capsuleWithSecret = authoritativeCapsule({ executionSummary: `The build succeeded. token=sk-${"a".repeat(20)} was used but this summary otherwise contains a great deal of ordinary descriptive text about what happened during the run.` });
    expect(checkCriticalRedactionCollapse(capsuleWithSecret)).toEqual({ ok: true });
  });

  it("rejects a critical field that collapses to almost nothing after redaction", () => {
    const collapsed = authoritativeCapsule({ executionSummary: `sk-${"a".repeat(5_000)}` });
    const result = checkCriticalRedactionCollapse(collapsed);
    expect(result.ok).toBe(false);
  });

  it("ignores empty/blank critical fields (nothing to collapse)", () => {
    expect(checkCriticalRedactionCollapse(authoritativeCapsule({ taskConstraints: [], acceptanceCriteria: [] }))).toEqual({ ok: true });
  });
});

describe("summarizeExecutionLogEvidence", () => {
  /** Unwraps the success case; a decode failure is a test failure, not a silent empty transcript. */
  function summarize(content: Buffer | null, producerTruncated = false) {
    const result = render(content, producerTruncated);
    if (!result.ok) throw new Error(`expected a decodable log, got: ${result.reason}`);
    return result.evidence;
  }

  /** The rendering path always takes the COMPLETE validated LOG part -- there is no signature that can lose the producer's provenance. */
  function render(content: Buffer | null, producerTruncated = false) {
    return summarizeExecutionLogEvidence(content === null ? null : validatedLogPart(content, {
      producerTruncated,
      producerOmittedByteCount: producerTruncated ? 512 : 0,
      producerTruncationMethod: producerTruncated ? "TAIL" : "NONE"
    }));
  }

  /** One complete, schema-valid NDJSON log record. */
  function record(message: string): string {
    return `${JSON.stringify({ type: "output", message, payload: {} })}\n`;
  }

  /** A complete NDJSON log of at least `byteTarget` bytes, always ending on a record boundary. */
  function manyRecords(byteTarget: number): string {
    let text = "";
    for (let index = 0; text.length < byteTarget; index += 1) text += record(`event ${index} ${"A".repeat(200)}`);
    return text;
  }

  it("returns EMPTY_EXECUTION_LOG_EVIDENCE for a null buffer (no LOG artifact)", () => {
    expect(summarize(null)).toEqual(EMPTY_EXECUTION_LOG_EVIDENCE);
  });

  it("includes short content in full, untruncated", () => {
    const content = Buffer.from(`${record("started")}${record("finished")}`, "utf8");
    const summary = summarize(content);
    expect(summary.available).toBe(true);
    expect(summary.anyTruncation).toBe(false);
    expect(summary.reviewerTruncated).toBe(false);
    expect(summary.reviewerTruncationMethod).toBe("NONE");
    expect(summary.preview).toBe(content.toString("utf8"));
    expect(summary.sourceByteCount).toBe(content.byteLength);
    expect(summary.reviewerIncludedByteCount).toBe(content.byteLength);
    expect(summary.reviewerOmittedByteCount).toBe(0);
    expect(summary.reviewerFinalRenderedByteCount).toBe(content.byteLength);
  });

  it("hashes the ORIGINAL RAW BYTES, not the decoded string", () => {
    const content = Buffer.from(record("héllo → wörld"), "utf8");
    const summary = summarize(content);
    expect(summary.includedContentSha256).toBe(createHash("sha256").update(content).digest("hex"));
  });

  it("hashes the exact rendered transcript separately from the source bytes it was rendered from", () => {
    const content = Buffer.from(record("rendered"), "utf8");
    const summary = summarize(content);
    expect(summary.reviewerRenderedSha256).toBe(createHash("sha256").update(summary.preview, "utf8").digest("hex"));
  });

  it("head+tail samples content larger than the EXECUTION_LOG budget, disclosing the omitted byte count", () => {
    const big = Buffer.from(manyRecords(AUTHORITATIVE_REVIEW_MATERIAL_BUDGET.categories.EXECUTION_LOG.maxIncludedBytes * 3), "utf8");
    const summary = summarize(big);
    expect(summary.anyTruncation).toBe(true);
    expect(summary.reviewerTruncated).toBe(true);
    expect(summary.reviewerTruncationMethod).toBe("HEAD_AND_TAIL");
    expect(summary.sourceByteCount).toBe(big.byteLength);
    expect(summary.reviewerOmittedByteCount).toBe(summary.sourceByteCount - summary.reviewerIncludedByteCount);
    expect(summary.reviewerOmittedByteCount).toBeGreaterThan(0);
    // Whole records only: the rendered transcript is still complete NDJSON.
    expect(summary.reviewerOmittedRecordCount).toBeGreaterThan(0);
    for (const line of summary.preview.slice(0, -1).split(String.fromCharCode(10))) expect(() => JSON.parse(line)).not.toThrow();
  });

  it("counts the omission marker toward the rendered size and keeps the whole render within the cap", () => {
    const cap = AUTHORITATIVE_REVIEW_MATERIAL_BUDGET.categories.EXECUTION_LOG.maxIncludedBytes;
    const summary = summarize(Buffer.from(manyRecords(cap * 3), "utf8"));
    expect(summary.reviewerMarkerByteCount).toBeGreaterThan(0);
    expect(summary.reviewerFinalRenderedByteCount).toBe(summary.reviewerIncludedByteCount + summary.reviewerMarkerByteCount);
    expect(Buffer.byteLength(summary.preview, "utf8")).toBe(summary.reviewerFinalRenderedByteCount);
    expect(summary.reviewerFinalRenderedByteCount).toBeLessThanOrEqual(cap);
  });

  it("distinguishes producer truncation from reviewer-side truncation", () => {
    const summary = summarize(Buffer.from(record("short"), "utf8"), true);
    expect(summary.producerTruncated).toBe(true);
    expect(summary.reviewerTruncated).toBe(false);
    expect(summary.anyTruncation).toBe(true);
    // The reviewer's own method describes the RENDER, and never overwrites what
    // the producer said about the stream it captured.
    expect(summary.reviewerTruncationMethod).toBe("NONE");
  });

  it("keeps the producer's truncation method out of the reviewer's rendering fields", () => {
    const content = `${record("kept")}`;
    const provenance: LogProvenance = {
      ...completeLogProvenance(content),
      originalRawByteCount: Buffer.byteLength(content, "utf8") + 900,
      omittedRawByteCount: 900,
      producerTruncated: true, truncationMethod: "TAIL", captureCompleteness: "TRUNCATED_KNOWN",
      recordCountOriginal: 7, recordCountIncluded: 1
    };
    const result = summarizeExecutionLogEvidence(validatedLogPart(content, {
      provenance, producerTruncated: true, producerOmittedByteCount: 900, producerTruncationMethod: "TAIL"
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.evidence.producerProvenance?.truncationMethod).toBe("TAIL");
    expect(result.evidence.producerProvenance?.originalRawByteCount).toBe(Buffer.byteLength(content, "utf8") + 900);
    // The reviewer rendered everything it was given -- its own accounting says
    // so, without contradicting or absorbing the producer's.
    expect(result.evidence.reviewerTruncationMethod).toBe("NONE");
    expect(result.evidence.reviewerOmittedByteCount).toBe(0);
    expect(result.evidence.sourceByteCount).toBe(Buffer.byteLength(content, "utf8"));
  });

  describe("strict UTF-8 and binary policy", () => {
    it("rejects invalid UTF-8 rather than substituting U+FFFD", () => {
      const result = render(Buffer.from([0x7b, 0xff, 0xfe, 0x7d]));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/not valid UTF-8/);
    });

    it("rejects a NUL byte", () => {
      const result = render(Buffer.from([0x61, 0x00, 0x62]));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/NUL byte/);
    });

    it("rejects a disallowed control byte", () => {
      const result = render(Buffer.from([0x61, 0x07, 0x62]));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/disallowed control character/);
    });

    it("rejects binary-like content", () => {
      const result = render(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      expect(result.ok).toBe(false);
    });

    it("rejects a UTF-8 BOM as an unsupported encoding", () => {
      const result = render(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("{}\n", "utf8")]));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/byte-order mark/);
    });

    it("accepts TAB and CR inside a record, which are explicitly permitted", () => {
      expect(render(Buffer.from(record(String.fromCharCode(9, 98, 13, 99)), "utf8")).ok).toBe(true);
    });

    it("accepts valid multi-plane Unicode", () => {
      expect(render(Buffer.from(record("héllo → 🌍 combining é"), "utf8")).ok).toBe(true);
    });
  });

  describe("a part that no longer describes its own bytes", () => {
    const content = `${record("one")}${record("two")}`;

    it("refuses a part whose recorded hash does not match the bytes it carries", () => {
      const result = summarizeExecutionLogEvidence(validatedLogPart(content, { overrides: { rawBytesHash: "0".repeat(64) } }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/no longer hashes/);
    });

    it("refuses a part whose recorded text is not what its bytes decode to", () => {
      const result = summarizeExecutionLogEvidence(validatedLogPart(content, { overrides: { validatedText: `${content}${record("three")}` } }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/decodes to different text/);
    });

    it("refuses a part whose recorded record list disagrees with its bytes", () => {
      const result = summarizeExecutionLogEvidence(validatedLogPart(content, { overrides: { parsedRecords: [] } }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/but its validation recorded 0/);
    });

    it("refuses provenance that does not describe the bytes it is attached to", () => {
      const result = summarizeExecutionLogEvidence(validatedLogPart(content, {
        provenance: { ...completeLogProvenance(content), includedContentHash: "0".repeat(64) }
      }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/included-content hash/);
    });
  });

  it("never blocks the review regardless of truncation -- EXECUTION_LOG is OPTIONAL and always disclosed", () => {
    const big = Buffer.from(manyRecords(AUTHORITATIVE_REVIEW_MATERIAL_BUDGET.categories.EXECUTION_LOG.maxIncludedBytes * 5), "utf8");
    expect(checkAuthoritativeMaterialPolicy(authoritativeCapsule({ executionLogEvidence: summarize(big) }), "", REQUEST_HASH).ok).toBe(true);
  });
});

describe("the exact serialized material byte ledger", () => {
  const budget = AUTHORITATIVE_REVIEW_MATERIAL_BUDGET;

  /** Runs the real policy path and returns the ledger it produced. */
  function ledgerFor(overrides: Partial<ReviewInputCapsule> = {}, policyPrompt = "") {
    const result = checkAuthoritativeMaterialPolicy(authoritativeCapsule(overrides), policyPrompt, REQUEST_HASH);
    if (!result.ok) throw new Error(`expected a ledger, got: ${result.reason}`);
    return { ...result, categoryLedger: result.sections.categoryLedger };
  }

  it("accepts a capsule comfortably within every category and the aggregate budget", () => {
    expect(ledgerFor().ledger.policyVersion).toBe(MATERIAL_BUDGET_POLICY_VERSION);
  });

  it("counts the reviewer policy prompt's real bytes rather than a declared zero", () => {
    const prompt = "P".repeat(4_096);
    const section = ledgerFor({}, prompt).categoryLedger.sections.find(entry => entry.category === "REVIEWER_POLICY_PROMPT");
    expect(section?.serializedBytes).toBe(Buffer.byteLength(prompt, "utf8"));
    expect(ledgerFor({}, "").categoryLedger.sections.find(entry => entry.category === "REVIEWER_POLICY_PROMPT")?.serializedBytes).toBe(0);
  });

  it("counts the artifact manifest's bytes", () => {
    expect(ledgerFor().categoryLedger.sections.some(entry => entry.category === "ARTIFACT_MANIFEST" && entry.serializedBytes > 0)).toBe(true);
  });

  it("counts task context, which the previous field-level accounting omitted entirely", () => {
    const withoutContext = ledgerFor({ taskContext: "" }).categoryLedger.totals.serializedBytes;
    const withContext = ledgerFor({ taskContext: "c".repeat(5_000) }).categoryLedger.totals.serializedBytes;
    expect(withContext - withoutContext).toBeGreaterThanOrEqual(5_000);
  });

  it("counts verification requirements, which the previous accounting also omitted", () => {
    const none = ledgerFor({ approvedVerificationOperations: [] }).categoryLedger.totals.serializedBytes;
    const some = ledgerFor({ approvedVerificationOperations: ["NPM_TEST", "NPM_BUILD"] }).categoryLedger.totals.serializedBytes;
    expect(some).toBeGreaterThan(none);
    expect(ledgerFor({ approvedVerificationOperations: ["NPM_TEST"] }).categoryLedger.sections.some(entry => entry.sectionId === "approvedSpecification")).toBe(true);
  });

  it("charges JSON escaping, so a string full of quotes costs more serialized bytes than its raw length", () => {
    const plainBytes = ledgerFor({ executionSummary: "a".repeat(1_000) }).categoryLedger.sections.find(entry => entry.sectionId === "executionSummary")!.serializedBytes;
    const escapedBytes = ledgerFor({ executionSummary: '"'.repeat(1_000) }).categoryLedger.sections.find(entry => entry.sectionId === "executionSummary")!.serializedBytes;
    expect(escapedBytes).toBe(plainBytes + 1_000);
  });

  it("accounts multibyte UTF-8 content by byte length, not character length", () => {
    const charCount = Math.floor(budget.categories.EXECUTION_SUMMARY.maxIncludedBytes / 3) + 10;
    const multibyteSummary = "€".repeat(charCount);
    expect(multibyteSummary.length).toBeLessThan(budget.categories.EXECUTION_SUMMARY.maxIncludedBytes);
    const result = checkAuthoritativeMaterialPolicy(authoritativeCapsule({ executionSummary: multibyteSummary }), "", REQUEST_HASH);
    expect(result.ok).toBe(false);
  });

  it("accepts a category at exactly its content byte boundary and rejects one byte more", () => {
    // The EXECUTION_SUMMARY category carries more than the summary text, so
    // the boundary is derived from the category's measured headroom rather
    // than assumed to equal the raw cap.
    const cap = budget.categories.EXECUTION_SUMMARY.maxIncludedBytes;
    const baseline = ledgerFor({ executionSummary: "" }).categoryLedger.sections
      .filter(entry => entry.category === "EXECUTION_SUMMARY")
      .reduce((sum, entry) => sum + entry.includedContentBytes, 0);
    const headroom = cap - baseline;
    expect(checkAuthoritativeMaterialPolicy(authoritativeCapsule({ executionSummary: "x".repeat(headroom) }), "", REQUEST_HASH).ok).toBe(true);
    const over = checkAuthoritativeMaterialPolicy(authoritativeCapsule({ executionSummary: "x".repeat(headroom + 1) }), "", REQUEST_HASH);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.reason).toContain("EXECUTION_SUMMARY");
  });

  it("enforces maxTotalOriginalBytes over the complete pre-truncation content", () => {
    const ledger = ledgerFor().categoryLedger;
    expect(ledger.totals.originalBytes).toBeGreaterThan(0);
    expect(ledger.totals.originalBytes).toBeLessThanOrEqual(budget.maxTotalOriginalBytes);
  });

  it("rejects when the aggregate total exceeds maxTotalIncludedBytes even though no single category is over its own cap", () => {
    const nearCap = (bytes: number) => "x".repeat(bytes);
    const result = checkAuthoritativeMaterialPolicy(authoritativeCapsule({
      taskObjective: nearCap(9_000),
      taskContext: nearCap(45_000),
      taskConstraints: Array.from({ length: 100 }, () => nearCap(2_000)),
      acceptanceCriteria: Array.from({ length: 100 }, () => nearCap(2_000)),
      finalGitEvidence: { ...authoritativeCapsule().finalGitEvidence, diffPreview: nearCap(budget.categories.GIT_DIFF.maxIncludedBytes - 200) }
    }), "", REQUEST_HASH);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/aggregate material budget|exceeds its material budget/);
  });

  it("rejects many individually-small artifact manifest entries whose combined size exceeds the ARTIFACT_MANIFEST cap", () => {
    const manyArtifacts = Array.from({ length: 200 }, (_, index) => ({
      artifactId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      artifactType: "VERIFICATION", relativePath: `executions/session/${"segment-".repeat(80)}${index}.json`,
      sha256: "b".repeat(64), byteCount: 1, truncated: false
    }));
    const result = checkAuthoritativeMaterialPolicy(authoritativeCapsule({ executionArtifactManifest: manyArtifacts }), "", REQUEST_HASH);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("ARTIFACT_MANIFEST");
  });

  it("rejects a single artifact whose recorded byteCount exceeds the per-artifact size limit", () => {
    const result = checkAuthoritativeMaterialPolicy(authoritativeCapsule({
      executionArtifactManifest: [{
        artifactId: "00000000-0000-4000-8000-0000000000b1", artifactType: "LOG", relativePath: "log.ndjson",
        sha256: "b".repeat(64), byteCount: budget.maxBytesPerArtifact + 1, truncated: false
      }]
    }), "", REQUEST_HASH);
    expect(result.ok).toBe(false);
  });

  it("charges duplicated content in full, so splitting identical content cannot evade the budget", () => {
    const repeated = "d".repeat(1_500);
    const one = ledgerFor({ taskConstraints: [repeated] }).categoryLedger.sections.find(entry => entry.category === "CONSTRAINTS")!;
    const three = ledgerFor({ taskConstraints: [repeated, repeated, repeated] }).categoryLedger.sections.find(entry => entry.category === "CONSTRAINTS")!;
    expect(three.includedContentBytes).toBe(one.includedContentBytes * 3);
    expect(three.serializedBytes).toBeGreaterThanOrEqual(4_500);
  });

  it("rejects a CONSTRAINTS set whose combined content exceeds its category cap even though each entry is small", () => {
    const entry = "c".repeat(2_000);
    const count = Math.ceil(budget.categories.CONSTRAINTS.maxIncludedBytes / 2_000) + 1;
    const result = checkAuthoritativeMaterialPolicy(authoritativeCapsule({ taskConstraints: Array.from({ length: count }, () => entry) }), "", REQUEST_HASH);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("CONSTRAINTS");
  });

  it("produces a stable canonical ledger hash for identical input and a different one for changed input", () => {
    expect(ledgerFor().ledgerHash).toBe(ledgerFor().ledgerHash);
    expect(ledgerFor({ executionSummary: "changed" }).ledgerHash).not.toBe(ledgerFor().ledgerHash);
  });
});

describe("checkAuthoritativeMaterialPolicy", () => {
  it("accepts a fully compliant AUTHORITATIVE capsule and returns its bound ledger", () => {
    const result = checkAuthoritativeMaterialPolicy(authoritativeCapsule(), "", REQUEST_HASH);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.ledgerHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("blocks on diff coverage before the budget check is even reached", () => {
    const evidence = {
      available: true, branch: "main", head: "b".repeat(40), dirty: true,
      changedFiles: [{ path: "src/never-mentioned.ts", status: "modified" as const, binary: false }],
      diffPreview: "no mention here", diffTruncated: true, diffOmittedForSensitivePaths: false
    };
    expect(checkAuthoritativeMaterialPolicy(authoritativeCapsule({ finalGitEvidence: evidence }), "", REQUEST_HASH).ok).toBe(false);
  });

  it("blocks on a failed, truncated verification result", () => {
    const result = checkAuthoritativeMaterialPolicy(authoritativeCapsule({ verificationEvidence: [verificationEntry({ passed: false, stdoutTruncated: true })] }), "", REQUEST_HASH);
    expect(result.ok).toBe(false);
  });

  it("blocks on an over-budget field", () => {
    const oversizedDiff = "x".repeat(AUTHORITATIVE_REVIEW_MATERIAL_BUDGET.categories.GIT_DIFF.maxIncludedBytes + 1);
    const result = checkAuthoritativeMaterialPolicy(authoritativeCapsule({ finalGitEvidence: { ...authoritativeCapsule().finalGitEvidence, diffPreview: oversizedDiff, diffTruncated: false } }), "", REQUEST_HASH);
    expect(result.ok).toBe(false);
  });
});
