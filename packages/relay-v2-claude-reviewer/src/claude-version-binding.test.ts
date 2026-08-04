import { describe, expect, it } from "vitest";
import type { ProcessRunRequest, ProcessRunner, ProcessRunnerEvent } from "@project-relay/relay-v2-execution";
import { EMPTY_EXECUTION_LOG_EVIDENCE, type ImmutableReviewCapsule } from "@project-relay/relay-v2-reviewer";
import { buildClaudeReviewerConfig } from "./build-claude-reviewer-config.js";
import { ClaudeCapabilityDiscovery, capabilitySemanticHash, toReviewerCapabilityDiagnostic } from "./claude-capabilities.js";
import { ClaudeCliReviewer } from "./claude-cli-reviewer.js";
import { claudeCliV2_1_220SampleVerdict, claudeCliV2_1_220WrapperFixture } from "./claude-cli-v2-1-220-wrapper.fixture.js";

/**
 * 2.1.220 and 2.1.221 share one verified wrapper contract. They do NOT share
 * an identity.
 *
 * A shared contract says "this parser understands both wrappers"; it says
 * nothing about whether a review authorized against one executable may run
 * against a different one. The CLI version, the executable hash, and the
 * capability semantic hash all stay bound per request, so a version change
 * still invalidates an existing request and still requires refreshed
 * diagnostics and a new ReviewRequest.
 */

const HELP_TEXT = [
  "-p, --print", "--output-format <format>", '"json"', "--json-schema <schema>", "--tools <tools...>", "--safe-mode",
  "--strict-mcp-config", "--no-session-persistence", "--disable-slash-commands"
].join(" ");

class VersionedDiscoveryRunner implements ProcessRunner {
  constructor(private readonly version: string) {}
  owns(): boolean { return false; }
  async cancel(): Promise<boolean> { return true; }
  async *run(request: ProcessRunRequest): AsyncIterable<ProcessRunnerEvent> {
    if (request.args[0] === "--version") yield { type: "stdout", message: this.version };
    else if (request.args[0] === "--help") yield { type: "stdout", message: HELP_TEXT };
    else if (request.args[0] === "auth") yield { type: "stdout", message: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }) };
    yield { type: "exit", result: { exitCode: 0, signal: null, timedOut: false, cancelled: false, outputTruncated: false, stdoutBytes: 0, stderrBytes: 0 } };
  }
}

async function snapshotFor(version: string) {
  return new ClaudeCapabilityDiscovery({ executablePath: process.execPath, runner: new VersionedDiscoveryRunner(version) }).discover();
}

class ApprovingCliRunner implements ProcessRunner {
  owns(): boolean { return false; }
  async cancel(): Promise<boolean> { return true; }
  async *run(request: ProcessRunRequest): AsyncIterable<ProcessRunnerEvent> {
    const stdin = request.stdin ?? "";
    const echo = {
      reviewedRequestHash: /requestHash:\s*([a-f0-9]{64})/.exec(stdin)?.[1] ?? "0".repeat(64),
      reviewedMaterialHash: /materialHash:\s*([a-f0-9]{64})/.exec(stdin)?.[1] ?? "0".repeat(64),
      reviewedPromptHash: /promptHash:\s*([a-f0-9]{64})/.exec(stdin)?.[1] ?? "0".repeat(64)
    };
    yield { type: "started", ownership: { executionId: "x", pid: 999, processIdentity: "id", startedAt: new Date().toISOString() } };
    yield { type: "stdout", message: JSON.stringify(claudeCliV2_1_220WrapperFixture(claudeCliV2_1_220SampleVerdict(echo))), rawByteCount: 64 };
    yield { type: "exit", result: { exitCode: 0, signal: null, timedOut: false, cancelled: false, outputTruncated: false, stdoutBytes: 64, stderrBytes: 0 } };
  }
}

function capsuleWith(config: ImmutableReviewCapsule["claudeReviewerConfig"]): ImmutableReviewCapsule {
  const hash64 = "d".repeat(64);
  return {
    reviewRequestId: "22222222-2222-2222-2222-222222222222", executionSessionId: "33333333-3333-3333-3333-333333333333",
    projectId: "44444444-4444-4444-4444-444444444444", taskId: "55555555-5555-5555-5555-555555555555",
    reviewerId: "claude-cli", reviewAuthority: "AUTHORITATIVE", diagnostic: false,
    approvalId: "66666666-6666-6666-6666-666666666666", approvalStatus: "APPROVED", approvedReviewer: "CLAUDE", taskSelectedReviewer: "CLAUDE",
    executionExecutorId: "codex-cli", taskTitle: "t", taskObjective: "o", taskContext: "c",
    taskSpecHash: hash64, canonicalTaskSpecHash: hash64, taskNormalizedSpecHash: hash64, approvalSnapshotHash: hash64,
    executionStatus: "SUCCEEDED", executionResultStatus: "succeeded", executionSummary: "s", executionSummaryHash: hash64,
    executionCapsuleHash: hash64, executionCapsuleJsonHash: hash64, baselineGitEvidenceHash: hash64, finalGitEvidenceHash: hash64,
    verificationResultsHash: hash64, executionArtifactSetHash: hash64, finalBranch: "main", finalHead: "abc123",
    requestedAt: new Date().toISOString(), reviewPolicyVersion: "2.3A-v1",
    taskConstraints: [], acceptanceCriteria: ["a"], approvedExecutorSelection: "CODEX", approvedModel: "AUTO", approvedEffort: "AUTO",
    approvedVerificationOperations: [],
    baselineGitEvidence: { available: false, branch: "", head: "", dirty: false, changedFiles: [], diffPreview: "", diffTruncated: false, diffOmittedForSensitivePaths: false },
    finalGitEvidence: { available: true, branch: "main", head: "abc123", dirty: false, changedFiles: [], diffPreview: "", diffTruncated: false, diffOmittedForSensitivePaths: false },
    verificationEvidence: [], executionArtifactManifest: [], executionLogEvidence: EMPTY_EXECUTION_LOG_EVIDENCE,
    requestHash: hash64, reviewInputHash: hash64, reviewerConfigHash: hash64,
    ...(config ? { claudeReviewerConfig: config } : {})
  };
}

const controls = () => ({ signal: new AbortController().signal, now: () => new Date(), sleep: async () => {} });

describe("CLI version stays bound even when two versions share a wrapper contract", () => {
  it("binds 2.1.221's own exact version, executable identity, and capability hash — while reusing the verified contract", async () => {
    const snapshot221 = await snapshotFor("2.1.221 (Claude Code)");
    const config = buildClaudeReviewerConfig(toReviewerCapabilityDiagnostic(snapshot221), "11111111-1111-1111-1111-111111111111");

    expect(config.cliVersion).toBe("2.1.221 (Claude Code)");
    expect(config.wrapperContractId).toBe("claude-json-schema-result-v1");
    expect(config.wrapperParserVersion).toBe("1");
    expect(config.executableIdentityHash).toBe(snapshot221.executableIdentityHash);
    expect(config.capabilitySnapshotHash).toBe(capabilitySemanticHash(toReviewerCapabilityDiagnostic(snapshot221)));
  });

  it("gives 2.1.220 and 2.1.221 different capability semantic hashes, so their requests can never be interchanged", async () => {
    const [a, b] = await Promise.all([snapshotFor("2.1.220 (Claude Code)"), snapshotFor("2.1.221 (Claude Code)")]);
    const [hashA, hashB] = [capabilitySemanticHash(toReviewerCapabilityDiagnostic(a)), capabilitySemanticHash(toReviewerCapabilityDiagnostic(b))];

    expect(hashA).not.toBe(hashB);
    // ...even though the wrapper contract they resolve to is identical.
    expect(a.wrapperContractId).toBe(b.wrapperContractId);
    expect(a.wrapperParserVersion).toBe(b.wrapperParserVersion);
  });

  it("refuses to run a request bound under 2.1.220 when the live CLI is now 2.1.221", async () => {
    const snapshot220 = await snapshotFor("2.1.220 (Claude Code)");
    const boundUnder220 = buildClaudeReviewerConfig(toReviewerCapabilityDiagnostic(snapshot220), "11111111-1111-1111-1111-111111111111");
    const snapshot221 = await snapshotFor("2.1.221 (Claude Code)");

    const reviewer = new ClaudeCliReviewer({ discovery: { discover: async () => snapshot221 }, runner: new ApprovingCliRunner() });
    await expect(reviewer.review(capsuleWith(boundUnder220), controls() as never))
      .rejects.toThrow(/installation changed since this review was requested/);
  });

  it("refuses the reverse direction too: a request bound under 2.1.221 against a live 2.1.220", async () => {
    const snapshot221 = await snapshotFor("2.1.221 (Claude Code)");
    const boundUnder221 = buildClaudeReviewerConfig(toReviewerCapabilityDiagnostic(snapshot221), "11111111-1111-1111-1111-111111111111");
    const snapshot220 = await snapshotFor("2.1.220 (Claude Code)");

    const reviewer = new ClaudeCliReviewer({ discovery: { discover: async () => snapshot220 }, runner: new ApprovingCliRunner() });
    await expect(reviewer.review(capsuleWith(boundUnder221), controls() as never))
      .rejects.toThrow(/installation changed since this review was requested/);
  });

  it("refuses to bind a request at all for an unobserved version, so no 2.1.222 request can exist to run", async () => {
    const snapshot222 = await snapshotFor("2.1.222 (Claude Code)");
    expect(snapshot222.supported).toBe(false);
    expect(() => buildClaudeReviewerConfig(toReviewerCapabilityDiagnostic(snapshot222), "11111111-1111-1111-1111-111111111111"))
      .toThrow(/not currently supported/);
  });
});
