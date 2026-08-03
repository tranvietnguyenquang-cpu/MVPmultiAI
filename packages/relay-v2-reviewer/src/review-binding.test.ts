import { describe, expect, it } from "vitest";
import { canonicalJson, hashTaskSpec, type NormalizedTaskSpec } from "@project-relay/relay-v2-domain";
import {
  computeCanonicalTaskSpecHash, computeRequestHash, computeReviewInputHash, computeTaskNormalizedSpecHash,
  reviewInputCapsuleSchema, sha256Hex, verifyCapsuleIntegrity, type ReviewInputCapsule
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
  ["reviewPolicyVersion", "9.9Z-v1"]
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
    const declaredFields = Object.keys(reviewInputCapsuleSchema.shape);
    const testedFields = ALL_FIELDS.map(([field]) => field);
    expect(new Set(testedFields)).toEqual(new Set(declaredFields));
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
