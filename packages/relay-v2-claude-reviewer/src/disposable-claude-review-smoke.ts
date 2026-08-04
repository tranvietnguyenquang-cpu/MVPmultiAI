import { createHash, randomUUID } from "node:crypto";
import { canonicalJson, MATERIAL_BUDGET_POLICY_VERSION, REVIEW_MATERIAL_ENVELOPE_VERSION, type ClaudeReviewerConfig, type ReviewerInvocationRecord } from "@project-relay/relay-v2-domain";
import type { ProcessRunner } from "@project-relay/relay-v2-execution";
import { buildReviewMaterialSections, type ImmutableReviewCapsule, type PreparedReviewInvocation, type PreparedReviewMaterial } from "@project-relay/relay-v2-reviewer";
import { capabilitySemanticHash, ClaudeCapabilityDiscovery, toReviewerCapabilityDiagnostic } from "./claude-capabilities.js";
import { ClaudeCliReviewer, type ClaudeCapabilityProvider, type RawInvocationOutcome } from "./claude-cli-reviewer.js";
import { CLAUDE_PROMPT_POLICY } from "./review-material.js";
import { EMPTY_EXECUTION_LOG_EVIDENCE } from "@project-relay/relay-v2-reviewer";

function hash(seed: string): string {
  return createHash("sha256").update(seed, "utf8").digest("hex");
}

/**
 * A tiny, entirely synthetic review capsule -- no Relay repository content
 * and no real user project. Every hash field is a deterministic placeholder;
 * this smoke only validates the safe-invocation/structured-output/hash-echo
 * properties, not any particular review outcome.
 */
export function sampleCapsule(config?: ClaudeReviewerConfig): ImmutableReviewCapsule {
  return {
    reviewRequestId: randomUUID(), executionSessionId: randomUUID(), projectId: randomUUID(), taskId: randomUUID(),
    reviewerId: "claude-cli", reviewAuthority: "AUTHORITATIVE", diagnostic: false,
    approvalId: randomUUID(), approvalStatus: "APPROVED", approvedReviewer: "CLAUDE", taskSelectedReviewer: "CLAUDE",
    executionExecutorId: "codex-cli",
    taskTitle: "Disposable smoke task", taskObjective: "Add a one-line comment to a sample file.",
    taskContext: "This is a disposable smoke-test capsule; it references no real project or repository.",
    taskSpecHash: hash("spec"), canonicalTaskSpecHash: hash("spec"), taskNormalizedSpecHash: hash("spec"), approvalSnapshotHash: hash("approval"),
    executionStatus: "SUCCEEDED", executionResultStatus: "succeeded", executionSummary: "The disposable smoke task completed.", executionSummaryHash: hash("summary"),
    executionCapsuleHash: hash("capsule"), executionCapsuleJsonHash: hash("capsule-json"),
    baselineGitEvidenceHash: hash("baseline"), finalGitEvidenceHash: hash("final"), verificationResultsHash: hash("verification"),
    executionArtifactSetHash: hash("artifacts"), finalBranch: "main", finalHead: hash("head").slice(0, 40),
    requestedAt: new Date().toISOString(), reviewPolicyVersion: "2.3A-v1",
    taskConstraints: [], acceptanceCriteria: ["The sample file contains exactly one added comment line."],
    approvedExecutorSelection: "CODEX", approvedModel: "AUTO", approvedEffort: "AUTO", approvedVerificationOperations: [],
    baselineGitEvidence: { available: false, branch: "", head: "", dirty: false, changedFiles: [], diffPreview: "", diffTruncated: false, diffOmittedForSensitivePaths: false },
    finalGitEvidence: {
      available: true, branch: "main", head: hash("head").slice(0, 40), dirty: true,
      changedFiles: [{ path: "sample.txt", status: "modified", binary: false }],
      diffPreview: "diff --git a/sample.txt b/sample.txt\n+++ a one-line comment\n", diffTruncated: false, diffOmittedForSensitivePaths: false
    },
    verificationEvidence: [], executionArtifactManifest: [],
    executionLogEvidence: EMPTY_EXECUTION_LOG_EVIDENCE,
    requestHash: hash("relay-v2-claude-smoke-request"), reviewInputHash: hash("relay-v2-claude-smoke-input"), reviewerConfigHash: hash("relay-v2-claude-smoke-config"),
    // Omitted entirely for the operator-gated unregistered-version structural
    // diagnostic, which has no bound reviewer configuration to speak of --
    // that path never constructs a ClaudeCliReviewer and never produces a
    // verdict, so there is nothing for a config to authorize.
    ...(config ? { claudeReviewerConfig: config } : {})
  };
}

export type RealClaudeReviewSmokeResult =
  | { status: "SKIPPED"; reason: string }
  | { status: "PASSED"; reviewedRequestHash: string; verdict: string };

export type ClaudeReviewSmokeOptions = {
  discovery?: ClaudeCapabilityProvider;
  runner?: ProcessRunner;
  /**
   * Opt-in, sanitized-diagnostic-only observer of the real invocation's raw
   * stdout/stderr, wired only by the smoke script's own
   * `RELAY_V2_CLAUDE_SMOKE_DIAGNOSTIC=1` gate (see `structural-diagnostics.ts`).
   * Never present in normal use; never changes this smoke's pass/fail outcome.
   */
  onRawInvocationOutcome?: (outcome: RawInvocationOutcome) => void | Promise<void>;
};

/**
 * Runs exactly one real, non-interactive, read-only Claude CLI review against
 * a disposable, synthetic capsule, entirely bypassing ReviewEngine/the
 * database (this is a safe-invocation/structured-output smoke, not a
 * lifecycle test). Validates: authentication, safe process invocation,
 * structured JSON-Schema-conformant response, exact requestHash echo, and
 * (via ClaudeCliReviewer's own internal check) that the disposable bundle
 * was not mutated by the run. Does not require or assert any particular
 * APPROVE/REJECT/NEEDS_CHANGES outcome.
 */
export async function runDisposableReadOnlyClaudeReviewSmoke(options: ClaudeReviewSmokeOptions = {}): Promise<RealClaudeReviewSmokeResult> {
  const discovery = options.discovery ?? new ClaudeCapabilityDiscovery();
  const snapshot = await discovery.discover();
  if (!snapshot.executablePath || !snapshot.supported || snapshot.authenticationStatus !== "AUTHENTICATED") {
    return { status: "SKIPPED", reason: snapshot.unsupportedReasons.join(" ") || `Claude CLI is unavailable (authenticationStatus=${snapshot.authenticationStatus}).` };
  }

  const config: ClaudeReviewerConfig = {
    reviewerId: "claude-cli", model: "AUTO", reasoningOrEffort: "AUTO", timeoutSeconds: 120,
    outputSchemaVersion: "claude-verdict-v1", materializerVersion: "claude-materializer-v1", promptPolicyVersion: "claude-prompt-policy-v1",
    wrapperContractId: snapshot.wrapperContractId, wrapperParserVersion: snapshot.wrapperParserVersion,
    capabilitySnapshotId: randomUUID(), capabilitySnapshotHash: capabilitySemanticHash(toReviewerCapabilityDiagnostic(snapshot)),
    executableIdentityHash: snapshot.executableIdentityHash, cliVersion: snapshot.version,
    readOnlyPolicy: "DENY_ALL_TOOLS", toolPolicy: "TOOLS_EMPTY_STRING",
    configurationIsolationPolicy: "SAFE_MODE_STRICT_MCP_NO_SESSION_NO_SLASH_COMMANDS", artifactSelectionPolicy: "BOUND_CAPSULE_ONLY",
    maximumInputBytes: 500_000, maximumOutputBytes: 2_000_000, materialBudgetVersion: "material-budget-v1"
  };
  const capsule = sampleCapsule(config);
  const reviewer = new ClaudeCliReviewer({
    discovery: { discover: async () => snapshot },
    ...(options.runner ? { runner: options.runner } : {}),
    ...(options.onRawInvocationOutcome ? { onRawInvocationOutcome: options.onRawInvocationOutcome } : {})
  });

  // The same immutable preparation ReviewEngine builds and persists before any
  // process exists. The smoke harness bypasses the database, not the contract:
  // the reviewer still receives prepared bytes it must send verbatim rather
  // than building its own material.
  const sections = buildReviewMaterialSections(capsule, CLAUDE_PROMPT_POLICY, capsule.requestHash);
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
  const prepared: PreparedReviewInvocation = { ...material, ...reviewer.prepareInvocation(capsule, material) };

  let recorded: ReviewerInvocationRecord | undefined;
  const verdict = await reviewer.review(capsule, {
    signal: new AbortController().signal, now: () => new Date(), sleep: async () => {},
    prepared,
    recordInvocation: async record => { recorded = record; }
  });

  if (verdict.reviewedRequestHash !== capsule.requestHash) {
    throw new Error("Claude CLI real smoke: reviewedRequestHash did not match the bound requestHash.");
  }
  if (!verdict.reviewedMaterialHash || !verdict.reviewedPromptHash) {
    throw new Error("Claude CLI real smoke: reviewedMaterialHash/reviewedPromptHash was not echoed.");
  }
  if (!recorded || !/^[a-f0-9]{64}$/.test(recorded.reviewMaterialHash) || !/^[a-f0-9]{64}$/.test(recorded.promptHash)) {
    throw new Error("Claude CLI real smoke: material/prompt hash was not recorded.");
  }

  return { status: "PASSED", reviewedRequestHash: verdict.reviewedRequestHash, verdict: verdict.verdict };
}
