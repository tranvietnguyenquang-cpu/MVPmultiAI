import { describe, expect, it } from "vitest";
import type { ProcessRunRequest, ProcessRunner, ProcessRunnerEvent } from "@project-relay/relay-v2-execution";
import { capabilitySemanticHash, toReviewerCapabilityDiagnostic, type ClaudeCapabilitySnapshot } from "./claude-capabilities.js";
import { claudeCliV2_1_220WrapperFixture, claudeCliV2_1_220SampleVerdict } from "./claude-cli-v2-1-220-wrapper.fixture.js";
import { ClaudeCliReviewer } from "./claude-cli-reviewer.js";
import { EMPTY_EXECUTION_LOG_EVIDENCE } from "@project-relay/relay-v2-reviewer";
import {
  runUnregisteredClaudeVersionStructuralDiagnostic, unsupportedSolelyBecauseUnregistered,
  UNREGISTERED_DIAGNOSTIC_GATE_ENVIRONMENT_VARIABLES, type UnregisteredVersionDiagnosticGates
} from "./unregistered-version-diagnostic.js";
import {
  resolveClaudeWrapperContract, SUPPORTED_CLAUDE_WRAPPER_CONTRACTS, unregisteredWrapperContractReason
} from "./wrapper-contract-catalog.js";

/**
 * The diagnostic-only unregistered-version mode is safe by construction, and
 * these tests pin exactly that: all three gates required, a refusal for any
 * problem other than the version being unregistered, no verdict/request/
 * database reachable from it, and no effect whatsoever on what the production
 * runtime will accept.
 */

/**
 * A version that is genuinely absent from the catalog. Deliberately the
 * release right after the newest registered one: registering an observed
 * version never implies anything about the next one.
 */
const UNREGISTERED_VERSION = "2.1.222";

const ALL_GATES: UnregisteredVersionDiagnosticGates = {
  realSmokeAuthorized: true, diagnosticEnabled: true, unregisteredVersionAllowed: true
};

/** An otherwise fully capable, authenticated CLI whose only defect is that `version` is not registered. */
function unregisteredButOtherwiseHealthy(version = UNREGISTERED_VERSION): ClaudeCapabilitySnapshot {
  return {
    reviewerId: "claude-cli", executablePath: process.execPath, displayPath: "%APPDATA%/.../claude.exe", version,
    detectedAt: new Date().toISOString(), printSupported: true, outputFormatJsonSupported: true, jsonSchemaSupported: true,
    toolsFlagSupported: true, safeModeSupported: true, strictMcpConfigSupported: true, noSessionPersistenceSupported: true,
    disableSlashCommandsSupported: true, authenticationStatus: "AUTHENTICATED", authMethod: "claude.ai",
    executableIdentityHash: "a".repeat(64), helpHash: "b".repeat(64),
    wrapperContractId: "", wrapperParserVersion: "",
    supported: false, unsupportedReasons: [unregisteredWrapperContractReason(version)]
  };
}

const discoveryFor = (snapshot: ClaudeCapabilitySnapshot) => ({ discover: async () => snapshot });

/** Replies with the verified 2.1.220 wrapper shape, echoing whatever hashes the prompt told it to echo. */
class WrapperReplyRunner implements ProcessRunner {
  readonly requests: ProcessRunRequest[] = [];
  constructor(private readonly build: (stdin: string) => string) {}
  owns(): boolean { return false; }
  async cancel(): Promise<boolean> { return true; }
  async *run(request: ProcessRunRequest): AsyncIterable<ProcessRunnerEvent> {
    this.requests.push(request);
    yield { type: "started", ownership: { executionId: "diag", pid: 4242, processIdentity: "diag-1", startedAt: new Date().toISOString() } };
    yield { type: "stdout", message: this.build(request.stdin ?? ""), rawByteCount: 128 };
    yield { type: "exit", result: { exitCode: 0, signal: null, timedOut: false, cancelled: false, outputTruncated: false, stdoutBytes: 128, stderrBytes: 0 } };
  }
}

function echoedFromStdin(stdin: string) {
  return {
    reviewedRequestHash: /requestHash:\s*([a-f0-9]{64})/.exec(stdin)?.[1] ?? "0".repeat(64),
    reviewedMaterialHash: /materialHash:\s*([a-f0-9]{64})/.exec(stdin)?.[1] ?? "0".repeat(64),
    reviewedPromptHash: /promptHash:\s*([a-f0-9]{64})/.exec(stdin)?.[1] ?? "0".repeat(64)
  };
}

const identicalWrapperRunner = () => new WrapperReplyRunner(stdin =>
  JSON.stringify(claudeCliV2_1_220WrapperFixture(claudeCliV2_1_220SampleVerdict(echoedFromStdin(stdin)))));

describe("unregistered-version diagnostic gates", () => {
  const gateCases: ReadonlyArray<readonly [string, UnregisteredVersionDiagnosticGates]> = [
    ["no gates at all", { realSmokeAuthorized: false, diagnosticEnabled: false, unregisteredVersionAllowed: false }],
    ["missing the real-smoke authorization", { ...ALL_GATES, realSmokeAuthorized: false }],
    ["missing the diagnostic gate", { ...ALL_GATES, diagnosticEnabled: false }],
    ["missing the unregistered-version gate", { ...ALL_GATES, unregisteredVersionAllowed: false }]
  ];

  it.each(gateCases)("refuses with %s, without discovering or running anything", async (_label, gates) => {
    let discovered = false;
    const runner = identicalWrapperRunner();
    const result = await runUnregisteredClaudeVersionStructuralDiagnostic({
      gates,
      discovery: { discover: async () => { discovered = true; return unregisteredButOtherwiseHealthy(); } },
      runner
    });

    expect(result.status).toBe("REFUSED");
    if (result.status !== "REFUSED") return;
    expect(result.missingGates.length).toBeGreaterThan(0);
    for (const missing of result.missingGates) expect(Object.values(UNREGISTERED_DIAGNOSTIC_GATE_ENVIRONMENT_VARIABLES)).toContain(missing);
    // Refused means refused: no capability discovery, no process.
    expect(discovered).toBe(false);
    expect(runner.requests).toHaveLength(0);
  });

  it("names every one of the three required environment variables", () => {
    expect(Object.values(UNREGISTERED_DIAGNOSTIC_GATE_ENVIRONMENT_VARIABLES)).toEqual([
      "RELAY_V2_REAL_CLAUDE_REVIEW_SMOKE",
      "RELAY_V2_CLAUDE_SMOKE_DIAGNOSTIC",
      "RELAY_V2_CLAUDE_ALLOW_UNREGISTERED_DIAGNOSTIC"
    ]);
  });
});

describe("unregistered-version diagnostic applicability", () => {
  it("runs, and reports DIAGNOSTIC_ONLY — never a pass, and never marking the version supported", async () => {
    const runner = identicalWrapperRunner();
    const result = await runUnregisteredClaudeVersionStructuralDiagnostic({
      gates: ALL_GATES, discovery: discoveryFor(unregisteredButOtherwiseHealthy()), runner
    });

    expect(result.status).toBe("DIAGNOSTIC_ONLY");
    if (result.status !== "DIAGNOSTIC_ONLY") return;
    expect(result).not.toHaveProperty("verdict");
    expect(result.versionNowSupported).toBe(false);
    expect(result.observedVersion).toBe(UNREGISTERED_VERSION);
    expect(result.semverToken).toBe(UNREGISTERED_VERSION);
    expect(result.bundleIntegrityFailure).toBeNull();
    // Observing the version changed nothing about what is supported.
    expect(resolveClaudeWrapperContract(UNREGISTERED_VERSION)).toBeUndefined();
    expect(result.registeredVersions).toEqual(Object.keys(SUPPORTED_CLAUDE_WRAPPER_CONTRACTS));
  });

  it("invokes the CLI with the same read-only controls a real review uses, and only through stdin", async () => {
    const runner = identicalWrapperRunner();
    await runUnregisteredClaudeVersionStructuralDiagnostic({
      gates: ALL_GATES, discovery: discoveryFor(unregisteredButOtherwiseHealthy()), runner
    });

    const request = runner.requests[0]!;
    for (const flag of ["-p", "--output-format", "--json-schema", "--tools", "--safe-mode", "--strict-mcp-config", "--no-session-persistence", "--disable-slash-commands"]) {
      expect(request.args).toContain(flag);
    }
    expect(request.args).toContain("");
    expect(request.stdin ?? "").toContain("REVIEW MATERIAL");
    // The bundle, never the Relay repository, and never material in argv.
    expect(request.cwd.startsWith(process.cwd())).toBe(false);
    expect(request.args.some(argument => argument.includes("REVIEW MATERIAL"))).toBe(false);
  });

  it("reports a wrapper identical to the verified contract as structurally identical", async () => {
    const result = await runUnregisteredClaudeVersionStructuralDiagnostic({
      gates: ALL_GATES, discovery: discoveryFor(unregisteredButOtherwiseHealthy()), runner: identicalWrapperRunner()
    });

    expect(result.status).toBe("DIAGNOSTIC_ONLY");
    if (result.status !== "DIAGNOSTIC_ONLY") return;
    expect(result.wrapperComparison.structurallyIdenticalToVerifiedContract).toBe(true);
    expect(result.wrapperComparison.topLevelKeys.identical).toBe(true);
    expect(result.wrapperComparison.authorityFields.allExactlyAsRequired).toBe(true);
    expect(result.wrapperComparison.resultAndStructuredOutputCanonicallyEqual).toBe(true);
    expect(result.wrapperComparison.hashEcho).toEqual({ requestHash: "MATCH", materialHash: "MATCH", promptHash: "MATCH" });
    expect(result.wrapperComparison.strictProductionParser.accepts).toBe(true);
  });

  it("reports an added wrapper field as a difference rather than tolerating it", async () => {
    const runner = new WrapperReplyRunner(stdin =>
      JSON.stringify(claudeCliV2_1_220WrapperFixture(claudeCliV2_1_220SampleVerdict(echoedFromStdin(stdin)), { brand_new_field: "surprise" })));
    const result = await runUnregisteredClaudeVersionStructuralDiagnostic({
      gates: ALL_GATES, discovery: discoveryFor(unregisteredButOtherwiseHealthy()), runner
    });

    expect(result.status).toBe("DIAGNOSTIC_ONLY");
    if (result.status !== "DIAGNOSTIC_ONLY") return;
    expect(result.wrapperComparison.topLevelKeys.unexpected).toEqual(["brand_new_field"]);
    expect(result.wrapperComparison.structurallyIdenticalToVerifiedContract).toBe(false);
    // The production parser still fails closed on it, unchanged.
    expect(result.wrapperComparison.strictProductionParser.accepts).toBe(false);
  });

  it("reports a changed field type as a difference", async () => {
    const runner = new WrapperReplyRunner(stdin =>
      JSON.stringify(claudeCliV2_1_220WrapperFixture(claudeCliV2_1_220SampleVerdict(echoedFromStdin(stdin)), { num_turns: "1" })));
    const result = await runUnregisteredClaudeVersionStructuralDiagnostic({
      gates: ALL_GATES, discovery: discoveryFor(unregisteredButOtherwiseHealthy()), runner
    });

    expect(result.status).toBe("DIAGNOSTIC_ONLY");
    if (result.status !== "DIAGNOSTIC_ONLY") return;
    const numTurns = result.wrapperComparison.fieldTypes.find(entry => entry.field === "num_turns");
    expect(numTurns).toMatchObject({ expectedType: "number", actualType: "string", matches: false });
    expect(result.wrapperComparison.structurallyIdenticalToVerifiedContract).toBe(false);
  });

  it("skips a version that is already registered, directing the operator to the normal smoke", async () => {
    const runner = identicalWrapperRunner();
    const result = await runUnregisteredClaudeVersionStructuralDiagnostic({
      gates: ALL_GATES, discovery: discoveryFor({ ...unregisteredButOtherwiseHealthy("2.1.220"), supported: true, unsupportedReasons: [] }), runner
    });

    expect(result.status).toBe("SKIPPED");
    if (result.status !== "SKIPPED") return;
    expect(result.reason).toMatch(/already has a registered wrapper contract/);
    expect(runner.requests).toHaveLength(0);
  });

  const otherDefects: ReadonlyArray<readonly [string, Partial<ClaudeCapabilitySnapshot>]> = [
    ["unauthenticated", { authenticationStatus: "UNAUTHENTICATED", unsupportedReasons: [unregisteredWrapperContractReason(UNREGISTERED_VERSION), "Claude CLI is not authenticated with a subscription session."] }],
    ["missing a required flag", { jsonSchemaSupported: false, unsupportedReasons: [unregisteredWrapperContractReason(UNREGISTERED_VERSION), "JSON Schema structured-output enforcement is unavailable."] }],
    ["not identifying as Claude Code", { unsupportedReasons: [unregisteredWrapperContractReason(UNREGISTERED_VERSION), "The executable's version/help output does not identify itself as Claude Code."] }]
  ];

  it.each(otherDefects)("refuses to run when the CLI is also %s, spawning nothing", async (_label, overrides) => {
    const runner = identicalWrapperRunner();
    const result = await runUnregisteredClaudeVersionStructuralDiagnostic({
      gates: ALL_GATES, discovery: discoveryFor({ ...unregisteredButOtherwiseHealthy(), ...overrides }), runner
    });

    expect(result.status).toBe("SKIPPED");
    if (result.status !== "SKIPPED") return;
    expect(result.reason).toMatch(/unsupported for reasons beyond its version not being registered/);
    expect(runner.requests).toHaveLength(0);
  });

  it("skips when no executable was found", async () => {
    const runner = identicalWrapperRunner();
    const result = await runUnregisteredClaudeVersionStructuralDiagnostic({
      gates: ALL_GATES, discovery: discoveryFor({ ...unregisteredButOtherwiseHealthy(), executablePath: "" }), runner
    });
    expect(result.status).toBe("SKIPPED");
    expect(runner.requests).toHaveLength(0);
  });
});

describe("unsupportedSolelyBecauseUnregistered", () => {
  it("recognizes the unregistered-contract reason by exact equality, not by message sniffing", () => {
    expect(unsupportedSolelyBecauseUnregistered(unregisteredButOtherwiseHealthy())).toBe(true);
    expect(unsupportedSolelyBecauseUnregistered({
      ...unregisteredButOtherwiseHealthy(),
      unsupportedReasons: [`Claude CLI version '${UNREGISTERED_VERSION}' has no registered wrapper contract (paraphrased).`]
    })).toBe(false);
  });

  it("is false for a supported CLI and for one with additional defects", () => {
    expect(unsupportedSolelyBecauseUnregistered({ ...unregisteredButOtherwiseHealthy(), supported: true, unsupportedReasons: [] })).toBe(false);
    expect(unsupportedSolelyBecauseUnregistered({
      ...unregisteredButOtherwiseHealthy(),
      unsupportedReasons: [unregisteredWrapperContractReason(UNREGISTERED_VERSION), "--safe-mode is unavailable."]
    })).toBe(false);
  });
});

describe("the normal runtime cannot bypass the catalog", () => {
  /** The production reviewer, given an unregistered CLI version and an otherwise-valid bound config. */
  async function reviewWithUnregisteredCli(snapshotOverrides: Partial<ClaudeCapabilitySnapshot> = {}): Promise<Error> {
    const snapshot = { ...unregisteredButOtherwiseHealthy(), ...snapshotOverrides };
    const reviewer = new ClaudeCliReviewer({ discovery: discoveryFor(snapshot), runner: identicalWrapperRunner() });
    const config = {
      reviewerId: "claude-cli", model: "AUTO", reasoningOrEffort: "AUTO", timeoutSeconds: 60,
      outputSchemaVersion: "claude-verdict-v1", materializerVersion: "claude-materializer-v1", promptPolicyVersion: "claude-prompt-policy-v1",
      wrapperContractId: "claude-json-schema-result-v1", wrapperParserVersion: "1",
      capabilitySnapshotId: "11111111-1111-1111-1111-111111111111",
      capabilitySnapshotHash: capabilitySemanticHash(toReviewerCapabilityDiagnostic(snapshot)),
      executableIdentityHash: snapshot.executableIdentityHash, cliVersion: snapshot.version,
      readOnlyPolicy: "DENY_ALL_TOOLS", toolPolicy: "TOOLS_EMPTY_STRING",
      configurationIsolationPolicy: "SAFE_MODE_STRICT_MCP_NO_SESSION_NO_SLASH_COMMANDS", artifactSelectionPolicy: "BOUND_CAPSULE_ONLY",
      maximumInputBytes: 500_000, maximumOutputBytes: 2_000_000, materialBudgetVersion: "material-budget-v1"
    } as const;
    const capsule = {
      reviewRequestId: "22222222-2222-2222-2222-222222222222", executionSessionId: "33333333-3333-3333-3333-333333333333",
      projectId: "44444444-4444-4444-4444-444444444444", taskId: "55555555-5555-5555-5555-555555555555",
      reviewerId: "claude-cli", reviewAuthority: "AUTHORITATIVE" as const, diagnostic: false,
      approvalId: "66666666-6666-6666-6666-666666666666", approvalStatus: "APPROVED",
      approvedReviewer: "CLAUDE" as const, taskSelectedReviewer: "CLAUDE" as const,
      executionExecutorId: "codex-cli", taskTitle: "t", taskObjective: "o", taskContext: "c",
      taskSpecHash: "d".repeat(64), canonicalTaskSpecHash: "d".repeat(64), taskNormalizedSpecHash: "d".repeat(64),
      approvalSnapshotHash: "d".repeat(64), executionStatus: "SUCCEEDED", executionResultStatus: "succeeded",
      executionSummary: "s", executionSummaryHash: "d".repeat(64), executionCapsuleHash: "d".repeat(64),
      executionCapsuleJsonHash: "d".repeat(64), baselineGitEvidenceHash: "d".repeat(64), finalGitEvidenceHash: "d".repeat(64),
      verificationResultsHash: "d".repeat(64), executionArtifactSetHash: "d".repeat(64), finalBranch: "main", finalHead: "abc123",
      requestedAt: new Date().toISOString(), reviewPolicyVersion: "2.3A-v1",
      taskConstraints: [], acceptanceCriteria: ["a"], approvedExecutorSelection: "CODEX" as const,
      approvedModel: "AUTO" as const, approvedEffort: "AUTO" as const, approvedVerificationOperations: [],
      baselineGitEvidence: { available: false, branch: "", head: "", dirty: false, changedFiles: [], diffPreview: "", diffTruncated: false, diffOmittedForSensitivePaths: false },
      finalGitEvidence: { available: true, branch: "main", head: "abc123", dirty: false, changedFiles: [], diffPreview: "", diffTruncated: false, diffOmittedForSensitivePaths: false },
      verificationEvidence: [], executionArtifactManifest: [], executionLogEvidence: EMPTY_EXECUTION_LOG_EVIDENCE,
      requestHash: "d".repeat(64), reviewInputHash: "d".repeat(64), reviewerConfigHash: "d".repeat(64),
      claudeReviewerConfig: config
    };
    try {
      await reviewer.review(capsule as never, { signal: new AbortController().signal, now: () => new Date(), sleep: async () => {} } as never);
      throw new Error("the reviewer accepted an unregistered CLI version");
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  }

  it("refuses to spawn the real CLI for an unregistered version, even with all three diagnostic gates set in the environment", async () => {
    // The diagnostic mode is not an environment flag the production reviewer
    // consults -- it is a separate code path in a separate module. Setting the
    // gates cannot influence this at all. Discovery already marks an
    // unregistered version unsupported, which is the first refusal.
    const error = await reviewWithUnregisteredCli();
    expect(error.message).toMatch(/unsupported/);
    expect(error.message).toMatch(/no registered, locally-verified wrapper contract/);
  });

  it("still refuses at the independent pre-spawn contract gate even if a snapshot claims to be supported", async () => {
    // Defence in depth: `supported: true` with an unregistered version is an
    // impossible state discovery cannot produce, but the reviewer re-resolves
    // the contract live immediately before spawning and refuses on its own.
    const error = await reviewWithUnregisteredCli({ supported: true, unsupportedReasons: [] });
    expect(error.message).toMatch(/no registered wrapper contract; refusing to spawn/);
  });

  it("keeps the catalog frozen against a runtime write", () => {
    expect(Object.isFrozen(SUPPORTED_CLAUDE_WRAPPER_CONTRACTS)).toBe(true);
    expect(() => {
      (SUPPORTED_CLAUDE_WRAPPER_CONTRACTS as Record<string, unknown>)[UNREGISTERED_VERSION] = { contractId: "x", parserVersion: "1" };
    }).toThrow();
    expect(resolveClaudeWrapperContract(UNREGISTERED_VERSION)).toBeUndefined();
  });
});
