import {
  canonicalJson, MATERIAL_BUDGET_POLICY_VERSION, REVIEW_MATERIAL_ENVELOPE_VERSION
} from "@project-relay/relay-v2-domain";
import { SafeProcessRunner, type ProcessRunner } from "@project-relay/relay-v2-execution";
import { buildReviewMaterialSections, type PreparedReviewMaterial } from "@project-relay/relay-v2-reviewer";
import { ClaudeCapabilityDiscovery, type ClaudeCapabilitySnapshot } from "./claude-capabilities.js";
import { buildClaudeReviewArgv } from "./claude-review-argv.js";
import type { ClaudeCapabilityProvider } from "./claude-cli-reviewer.js";
import { prepareDisposableReviewBundle } from "./disposable-review-bundle.js";
import { sampleCapsule } from "./disposable-claude-review-smoke.js";
import { CLAUDE_PROMPT_POLICY, CLAUDE_VERDICT_JSON_SCHEMA, prepareClaudeInvocation } from "./review-material.js";
import { buildRawInvocationStructuralReport, type RawInvocationStructuralReport } from "./structural-diagnostics.js";
import { compareWrapperToVerifiedContract, type WrapperContractComparison } from "./wrapper-contract-comparison.js";
import {
  claudeSemverToken, resolveClaudeWrapperContract, SUPPORTED_CLAUDE_WRAPPER_CONTRACTS,
  unregisteredWrapperContractReason
} from "./wrapper-contract-catalog.js";

/**
 * Operator-gated, diagnostic-ONLY structural inspection of a Claude CLI
 * version that has no registered wrapper contract.
 *
 * ## What this exists for
 *
 * The contract catalog is deliberately exact: an unregistered version — even a
 * patch release — cannot back an AUTHORITATIVE review. That is the right
 * default, and it creates one legitimate problem: registering a new version
 * responsibly requires *seeing* that version's actual wrapper output, and the
 * only way to see it is to run the CLI, which the catalog forbids. This path
 * resolves that without weakening anything, by running the CLI **as an
 * observation, not as a review**.
 *
 * ## What makes it safe
 *
 * It is safe by construction, not by policy:
 *
 * - It lives only in this module, reachable only from the standalone smoke
 *   harness. `ReviewEngine`, the API, the UI, and `ClaudeCliReviewer` have no
 *   path to it — `relay-v2-reviewer` does not import this package at all.
 * - It takes no database. It cannot create a `ReviewRequest` or a
 *   `ReviewVerdict` because it has nothing to create them with.
 * - It never constructs a `ClaudeCliReviewer`, so no verdict is ever produced,
 *   parsed as authoritative, or returned. Its result type has no verdict.
 * - It never writes to `SUPPORTED_CLAUDE_WRAPPER_CONTRACTS`, which is a frozen
 *   module constant; registering a version is a human code change reviewed
 *   like any other.
 * - It requires all three operator gates, and refuses when the CLI is
 *   unsupported for any reason *other* than being unregistered — an
 *   unauthenticated CLI, a missing required flag, or an executable that does
 *   not identify itself as Claude Code is still refused outright.
 * - It invokes the CLI with the exact same read-only argv a real review uses
 *   (`--tools ""`, `--safe-mode`, `--strict-mcp-config`,
 *   `--no-session-persistence`, `--disable-slash-commands`) in the same
 *   disposable bundle outside the Relay repository, against an entirely
 *   synthetic capsule that references no real project.
 * - Its terminal status is `DIAGNOSTIC_ONLY`. There is no code path by which
 *   it returns `PASSED`.
 */

/** All three must be present. Passed explicitly rather than read from the environment here, so the gate is directly testable and this module has no ambient authority of its own. */
export type UnregisteredVersionDiagnosticGates = {
  /** `RELAY_V2_REAL_CLAUDE_REVIEW_SMOKE=1` */
  realSmokeAuthorized: boolean;
  /** `RELAY_V2_CLAUDE_SMOKE_DIAGNOSTIC=1` */
  diagnosticEnabled: boolean;
  /** `RELAY_V2_CLAUDE_ALLOW_UNREGISTERED_DIAGNOSTIC=1` */
  unregisteredVersionAllowed: boolean;
};

export const UNREGISTERED_DIAGNOSTIC_GATE_ENVIRONMENT_VARIABLES = Object.freeze({
  realSmokeAuthorized: "RELAY_V2_REAL_CLAUDE_REVIEW_SMOKE",
  diagnosticEnabled: "RELAY_V2_CLAUDE_SMOKE_DIAGNOSTIC",
  unregisteredVersionAllowed: "RELAY_V2_CLAUDE_ALLOW_UNREGISTERED_DIAGNOSTIC"
} as const);

export type UnregisteredVersionDiagnosticResult =
  /** A required gate was absent. Nothing was run. */
  | { status: "REFUSED"; reason: string; missingGates: string[] }
  /** Not applicable, or refused for a reason other than the version being unregistered. Nothing was run. */
  | { status: "SKIPPED"; reason: string }
  /** The CLI was observed. This is never a pass, and never authorizes anything. */
  | {
      status: "DIAGNOSTIC_ONLY";
      observedVersion: string;
      semverToken: string | undefined;
      registeredVersions: string[];
      /** Always false: observing a version never marks it supported. */
      versionNowSupported: false;
      structuralReport: RawInvocationStructuralReport;
      wrapperComparison: WrapperContractComparison;
      /** Non-null only if the disposable bundle was mutated during the run, which invalidates the observation. */
      bundleIntegrityFailure: string | null;
      nextStep: string;
    };

export type UnregisteredVersionDiagnosticOptions = {
  gates: UnregisteredVersionDiagnosticGates;
  discovery?: ClaudeCapabilityProvider;
  runner?: ProcessRunner;
  environment?: NodeJS.ProcessEnv;
  /** Bounded so a pathological run cannot produce an unbounded capture. */
  timeoutSeconds?: number;
  maximumOutputBytes?: number;
};

function missingGateNames(gates: UnregisteredVersionDiagnosticGates): string[] {
  return (Object.keys(UNREGISTERED_DIAGNOSTIC_GATE_ENVIRONMENT_VARIABLES) as Array<keyof UnregisteredVersionDiagnosticGates>)
    .filter(gate => !gates[gate])
    .map(gate => UNREGISTERED_DIAGNOSTIC_GATE_ENVIRONMENT_VARIABLES[gate]);
}

/**
 * True when the ONLY thing wrong with this CLI is that its version is not in
 * the catalog. Compared by exact equality against the reason capability
 * discovery actually records, never by matching on message text.
 */
export function unsupportedSolelyBecauseUnregistered(snapshot: ClaudeCapabilitySnapshot): boolean {
  if (snapshot.supported) return false;
  const expected = unregisteredWrapperContractReason(snapshot.version);
  return snapshot.unsupportedReasons.length === 1 && snapshot.unsupportedReasons[0] === expected;
}

export async function runUnregisteredClaudeVersionStructuralDiagnostic(
  options: UnregisteredVersionDiagnosticOptions
): Promise<UnregisteredVersionDiagnosticResult> {
  const missing = missingGateNames(options.gates);
  if (missing.length) {
    return {
      status: "REFUSED",
      missingGates: missing,
      reason: `The unregistered-version structural diagnostic requires all of ${Object.values(UNREGISTERED_DIAGNOSTIC_GATE_ENVIRONMENT_VARIABLES).join(", ")} to be set to 1; missing: ${missing.join(", ")}.`
    };
  }

  const discovery = options.discovery ?? new ClaudeCapabilityDiscovery();
  const snapshot = await discovery.discover();

  if (!snapshot.executablePath) {
    return { status: "SKIPPED", reason: "Claude CLI executable was not found; there is nothing to inspect." };
  }
  const semverToken = claudeSemverToken(snapshot.version);
  if (semverToken && resolveClaudeWrapperContract(semverToken)) {
    return {
      status: "SKIPPED",
      reason: `Claude CLI ${snapshot.version} already has a registered wrapper contract; run the normal smoke instead of the unregistered-version diagnostic.`
    };
  }
  if (!unsupportedSolelyBecauseUnregistered(snapshot)) {
    // Refused rather than "diagnosed anyway": this mode exists to inspect a
    // wrapper shape, not to run an unauthenticated or capability-deficient
    // CLI. Those problems must be fixed before the shape means anything.
    return {
      status: "SKIPPED",
      reason: `Claude CLI ${snapshot.version || "(unknown version)"} is unsupported for reasons beyond its version not being registered, so its wrapper shape would not be meaningful: ${snapshot.unsupportedReasons.join(" ")}`
    };
  }

  // The exact material a real review would send, built by the production
  // builders from an entirely synthetic capsule -- so the observed wrapper is
  // the wrapper Claude produces for a real review's input shape, not for some
  // simplified probe that might elicit a different response shape.
  const capsule = sampleCapsule();
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
  const prepared = prepareClaudeInvocation(capsule, material);

  const bundle = await prepareDisposableReviewBundle({
    reviewRequestId: capsule.reviewRequestId,
    requestHash: capsule.requestHash,
    materialJson: material.materialCanonicalJson,
    verdictJsonSchema: CLAUDE_VERDICT_JSON_SCHEMA,
    promptText: prepared.finalStdin
  });

  try {
    const runner = options.runner ?? new SafeProcessRunner();
    let stdout = "";
    let stderr = "";
    let exitCode: number | null = null;
    let signal: string | null = null;
    let timedOut = false;

    for await (const event of runner.run({
      executionId: capsule.reviewRequestId,
      executablePath: snapshot.executablePath,
      // Byte-for-byte the same read-only invocation controls a real review
      // uses -- no tools, no MCP, no session persistence, no slash commands.
      args: buildClaudeReviewArgv({ model: "AUTO", reasoningOrEffort: "AUTO" }),
      cwd: bundle.bundlePath,
      stdin: prepared.finalStdin,
      timeoutMs: (options.timeoutSeconds ?? 120) * 1_000,
      maxOutputBytes: options.maximumOutputBytes ?? 2_000_000,
      environment: options.environment ?? process.env
    })) {
      if (event.type === "stdout") stdout += event.message;
      else if (event.type === "stderr") stderr += event.message;
      else if (event.type === "exit") {
        exitCode = event.result.exitCode;
        signal = event.result.signal;
        timedOut = event.result.timedOut;
      }
    }

    const unchanged = await bundle.verifyUnchanged();

    return {
      status: "DIAGNOSTIC_ONLY",
      observedVersion: snapshot.version,
      semverToken,
      registeredVersions: Object.keys(SUPPORTED_CLAUDE_WRAPPER_CONTRACTS),
      versionNowSupported: false,
      structuralReport: buildRawInvocationStructuralReport({ stdout, stderr, exitCode, signal, timedOut }),
      wrapperComparison: compareWrapperToVerifiedContract({
        rawStdout: stdout,
        expectedEcho: {
          requestHash: capsule.requestHash,
          materialHash: material.materialHash,
          promptHash: prepared.promptHash
        }
      }),
      bundleIntegrityFailure: unchanged ? null : "The disposable review bundle was modified during the diagnostic invocation; the observation cannot be trusted.",
      nextStep: "Supply this report to the implementer. Registering this version is a deliberate code change to SUPPORTED_CLAUDE_WRAPPER_CONTRACTS, made only if the comparison shows the wrapper is structurally and semantically identical to the verified contract; otherwise a distinct contract id/parser version and its own strict schema are required."
    };
  } finally {
    await bundle.cleanup();
  }
}
