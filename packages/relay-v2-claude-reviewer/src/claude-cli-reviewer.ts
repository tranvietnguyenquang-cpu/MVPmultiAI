import {
  claudeReviewerConfigSchema,
  reviewerDescriptorSchema,
  type ReviewerCapabilityDiagnostic,
  type ReviewerDescriptor,
  type ReviewerInvocationRecord,
  type StructuredReviewVerdict
} from "@project-relay/relay-v2-domain";
import { SafeProcessRunner, type ProcessRunner } from "@project-relay/relay-v2-execution";
import type {
  ImmutableReviewCapsule,
  PreparedReviewInvocation,
  PreparedReviewMaterial,
  PreparedReviewerInvocation,
  RelayReviewer,
  ReviewControls,
  ReviewerHealth,
  ReviewerValidationRequest,
  ReviewerValidationResult
} from "@project-relay/relay-v2-reviewer";
import { capabilitySemanticHash, ClaudeCapabilityDiscovery, toReviewerCapabilityDiagnostic, type ClaudeCapabilitySnapshot } from "./claude-capabilities.js";
import { resolveClaudeWrapperContract } from "./wrapper-contract-catalog.js";
import { prepareDisposableReviewBundle } from "./disposable-review-bundle.js";
import { buildClaudeReviewArgv } from "./claude-review-argv.js";
import { assertPromptWithinBudget, prepareClaudeInvocation, CLAUDE_PROMPT_POLICY, CLAUDE_VERDICT_JSON_SCHEMA } from "./review-material.js";
import { parseClaudeVerdict, parseClaudeTestDoubleVerdict } from "./verdict-parser.js";

function boundText(text: string, maxLength: number): { text: string; truncated: boolean } {
  return text.length <= maxLength ? { text, truncated: false } : { text: text.slice(0, maxLength), truncated: true };
}

type ProcessOwnershipInfo = { pid: number; processIdentity: string; startedAt: string };

type InvocationOutcome = {
  stdout: string;
  stderr: string;
  ownership: ProcessOwnershipInfo | undefined;
  exitCode: number | null;
  processSignal: string | null;
  timedOut: boolean;
  cancelled: boolean;
  structuredOutputJson?: string;
  finishedAt: string;
};

/**
 * Real, read-only local Claude CLI reviewer. Never receives a workspace,
 * process handle, or credential -- only the immutable, hash-bound
 * ImmutableReviewCapsule and its own bound reviewerConfig. Runs the real
 * `claude` subscription CLI, once, in a disposable bundle outside the Relay
 * repository, with all tools/MCP/hooks/plugins/session-persistence disabled,
 * and parses its structured JSON output into exactly one validated
 * StructuredReviewVerdict. See docs/CLAUDE_REVIEWER.md for the full safety
 * model and verified capability list.
 */
export interface ClaudeCapabilityProvider { discover(): Promise<ClaudeCapabilitySnapshot>; }

/**
 * The exact raw bytes/metadata of one real invocation, offered to an
 * observer before any verdict parsing is attempted. Purely diagnostic --
 * never consulted by `review()` itself and never able to change its
 * accept/reject outcome. Used only by the opt-in real smoke harness's
 * structural-diagnostic mode (see `disposable-claude-review-smoke.ts` and
 * `structural-diagnostics.ts`) to reveal the real CLI's transport shape when
 * strict parsing rejects it.
 */
export type RawInvocationOutcome = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  cancelled: boolean;
};

export class ClaudeCliReviewer implements RelayReviewer {
  readonly id = "claude-cli";
  private readonly discovery: ClaudeCapabilityProvider;
  private readonly runner: ProcessRunner;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly now: () => Date;
  private readonly cancelled = new Set<string>();
  private readonly onRawInvocationOutcome: ((outcome: RawInvocationOutcome) => void | Promise<void>) | undefined;
  /**
   * Set only by the gated Claude CLI process test double (never by the
   * production `new ClaudeCliReviewer()` construction path used everywhere
   * else). When true, `review()` uses `parseClaudeTestDoubleVerdict` (bare
   * verdict object, no transport wrapper) instead of the strict real-wrapper
   * `parseClaudeVerdict`. There is no fallback between the two: exactly one
   * is chosen up front by this flag, never tried-then-retried.
   */
  private readonly allowBareVerdictTestDouble: boolean;

  constructor(options: {
    discovery?: ClaudeCapabilityProvider;
    runner?: ProcessRunner;
    environment?: NodeJS.ProcessEnv;
    now?: () => Date;
    onRawInvocationOutcome?: (outcome: RawInvocationOutcome) => void | Promise<void>;
    allowBareVerdictTestDouble?: boolean;
  } = {}) {
    this.discovery = options.discovery ?? new ClaudeCapabilityDiscovery();
    this.runner = options.runner ?? new SafeProcessRunner();
    this.environment = options.environment ?? process.env;
    this.now = options.now ?? (() => new Date());
    this.onRawInvocationOutcome = options.onRawInvocationOutcome;
    this.allowBareVerdictTestDouble = options.allowBareVerdictTestDouble ?? false;
  }

  describe(): ReviewerDescriptor {
    return reviewerDescriptorSchema.parse({
      id: this.id,
      displayName: "Claude CLI",
      providerType: "LOCAL_CLI",
      readOnly: true,
      structuredOutput: true,
      cancellationSupport: true,
      capabilities: ["subscription-cli", "json-schema-output", "no-tool-review", "disposable-bundle"]
    });
  }

  /** The exact policy header this reviewer sends, so ReviewEngine can charge its bytes to the REVIEWER_POLICY_PROMPT budget category. */
  materialPolicyPrompt(): string {
    return CLAUDE_PROMPT_POLICY;
  }

  /**
   * Builds this invocation's exact prompt and stdin from the immutable
   * material envelope, before ReviewEngine persists the invocation identity
   * and before any process exists. Pure and deterministic: ReviewEngine runs
   * this again at finalization and requires the results to be identical.
   */
  prepareInvocation(capsule: ImmutableReviewCapsule, material: PreparedReviewMaterial): PreparedReviewerInvocation {
    return prepareClaudeInvocation(capsule, material);
  }

  async refreshCapabilities(): Promise<ReviewerCapabilityDiagnostic> {
    return toReviewerCapabilityDiagnostic(await this.discovery.discover());
  }

  async validate(request: ReviewerValidationRequest): Promise<ReviewerValidationResult> {
    if (!request.executionSessionId) return { valid: false, reason: "An execution session is required." };
    if (!claudeReviewerConfigSchema.safeParse(request.reviewerConfig).success) return { valid: false, reason: "Claude reviewer configuration is invalid or incomplete." };
    return { valid: true };
  }

  private assertLiveSnapshotMatchesBinding(snapshot: ClaudeCapabilitySnapshot, config: NonNullable<ImmutableReviewCapsule["claudeReviewerConfig"]>): void {
    if (!snapshot.supported) throw new Error(`Claude CLI is unsupported: ${snapshot.unsupportedReasons.join(" ") || "no reason reported"}.`);
    if (snapshot.authenticationStatus !== "AUTHENTICATED") throw new Error("Claude CLI is not authenticated with a subscription session.");
    if (!snapshot.executablePath) throw new Error("Claude CLI executable is unavailable.");
    // Live pre-spawn re-check against the exact same version-to-wrapper
    // catalog capability discovery already consulted -- redundant with
    // `snapshot.supported` today (discovery already folds this in), but an
    // explicit, independent gate here means this reviewer can never spawn
    // the real CLI for an unregistered version even if some future
    // discovery change ever weakened that upstream check. Matches
    // discovery's own semver-token extraction (`--version` output may carry
    // trailing decoration such as "(Claude Code)"). Skipped only for the
    // gated bare-verdict test double, which deliberately never goes through
    // real discovery or the real wrapper transport shape at all (it uses
    // `parseClaudeTestDoubleVerdict`, not `parseClaudeVerdict`) -- the
    // wrapper-contract catalog has nothing to say about it either way.
    if (!this.allowBareVerdictTestDouble) {
      const semverToken = /^(\d+\.\d+\.\d+)/.exec(snapshot.version)?.[1];
      const wrapperContract = semverToken ? resolveClaudeWrapperContract(semverToken) : undefined;
      if (!wrapperContract) throw new Error(`Claude CLI version '${snapshot.version}' has no registered wrapper contract; refusing to spawn.`);
      // The bound config's wrapperContractId/wrapperParserVersion were
      // resolved from a diagnostic captured at request time; re-resolve them
      // live, right before spawning, and require an exact match. This is what
      // actually blocks a deployment that remaps the same CLI version string
      // to a different verified contract (or a capability refresh that
      // resolves to no contract at all) from ever invoking the real CLI
      // under a stale binding -- capabilitySemanticHash drift below would
      // eventually catch this too, but this is the direct, unambiguous check.
      if (wrapperContract.contractId !== config.wrapperContractId || wrapperContract.parserVersion !== config.wrapperParserVersion) {
        throw new Error("The local Claude CLI's wrapper contract or parser version changed since this review was requested; a new review request is required.");
      }
    }
    if (snapshot.executableIdentityHash !== config.executableIdentityHash || snapshot.version !== config.cliVersion) {
      throw new Error("The local Claude CLI installation changed since this review was requested; a new review request is required.");
    }
    // Executable identity/version staying the same does not prove the
    // *semantic capability set* (which flags/behaviors are actually
    // supported) is unchanged -- a CLI update can change --help output
    // without bumping the reported version string. Recompute the same
    // capabilitySnapshotHash buildClaudeReviewerConfig computed at request
    // time (sha256 of the canonicalized sanitized diagnostic) from the fresh
    // live snapshot and require it to still match bit for bit; any drift
    // blocks the review before the process is ever spawned.
    if (capabilitySemanticHash(toReviewerCapabilityDiagnostic(snapshot)) !== config.capabilitySnapshotHash) {
      throw new Error("The local Claude CLI's capability set changed since this review was requested; a new review request is required.");
    }
  }

  private async reportInvocation(
    controls: ReviewControls,
    config: NonNullable<ImmutableReviewCapsule["claudeReviewerConfig"]>,
    snapshot: ClaudeCapabilitySnapshot,
    prepared: PreparedReviewInvocation,
    outcome: InvocationOutcome
  ): Promise<void> {
    if (!controls.recordInvocation) return;
    const stdout = boundText(outcome.stdout, 65_536);
    const stderr = boundText(outcome.stderr, 65_536);
    const record: ReviewerInvocationRecord = {
      reviewerId: this.id,
      capabilitySnapshotId: config.capabilitySnapshotId,
      cliVersion: snapshot.version,
      executableIdentityHash: snapshot.executableIdentityHash,
      materializerVersion: config.materializerVersion,
      promptPolicyVersion: config.promptPolicyVersion,
      wrapperContractId: config.wrapperContractId,
      wrapperParserVersion: config.wrapperParserVersion,
      // Echoed from the immutable preparation ReviewEngine already persisted,
      // never recomputed here: this record is a forensic report about a
      // process, not a second opinion on what was sent.
      reviewMaterialHash: prepared.materialHash,
      promptHash: prepared.promptHash,
      materialBudgetLedgerHash: prepared.ledgerHash,
      finalStdinHash: prepared.finalStdinHash,
      promptAccounting: prepared.promptAccounting,
      stdoutRedacted: stdout.text,
      stdoutTruncated: stdout.truncated,
      stderrRedacted: stderr.text,
      stderrTruncated: stderr.truncated,
      structuredOutputJson: outcome.structuredOutputJson ?? null,
      processId: outcome.ownership?.pid ?? null,
      processIdentity: outcome.ownership?.processIdentity ?? null,
      processStartedAt: outcome.ownership?.startedAt ?? null,
      processFinishedAt: outcome.finishedAt,
      processExitCode: outcome.exitCode,
      processSignal: outcome.processSignal,
      timedOut: outcome.timedOut,
      cancelled: outcome.cancelled
    };
    await controls.recordInvocation(record);
  }

  async review(capsule: ImmutableReviewCapsule, controls: ReviewControls): Promise<StructuredReviewVerdict> {
    const config = capsule.claudeReviewerConfig;
    if (!config) throw new Error("Claude review requires a bound claude-cli reviewer configuration.");
    if (controls.signal.aborted || this.cancelled.has(capsule.reviewRequestId)) throw controls.signal.reason ?? new DOMException("Review cancelled.", "AbortError");

    // Never trust the bound config's identity fields for authorization by
    // themselves: re-verify live, immediately before invoking the real CLI.
    const snapshot = await this.discovery.discover();
    this.assertLiveSnapshotMatchesBinding(snapshot, config);
    if (controls.signal.aborted || this.cancelled.has(capsule.reviewRequestId)) throw controls.signal.reason ?? new DOMException("Review cancelled.", "AbortError");

    // The immutable preparation ReviewEngine built and DURABLY PERSISTED
    // before this call. Nothing is rebuilt here: the invocation row already
    // commits to this exact material, prompt, and stdin, and finalization
    // refuses any verdict whose independent reconstruction disagrees with it.
    // Rebuilding would reintroduce precisely the gap this replaces -- a
    // process fed one set of bytes while the durable record described another.
    const prepared = controls.prepared;
    if (!prepared) throw new Error("Claude review requires an immutable prepared invocation; ReviewEngine did not supply one, so no process may be started.");
    const materialHash = prepared.materialHash;
    const promptHash = prepared.promptHash;

    // The final budget gate on the exact bytes about to be written to the
    // reviewer CLI's stdin, run immediately before spawning: the prompt cap
    // and the stdin cap are enforced independently, so a prompt one byte over
    // its own ceiling is rejected even while still under the stdin ceiling.
    assertPromptWithinBudget(prepared, config);

    const bundle = await prepareDisposableReviewBundle({
      reviewRequestId: capsule.reviewRequestId, requestHash: capsule.requestHash,
      materialJson: prepared.materialCanonicalJson, verdictJsonSchema: CLAUDE_VERDICT_JSON_SCHEMA, promptText: prepared.finalStdin
    });

    try {
      let stdout = "";
      let stderr = "";
      let ownership: InvocationOutcome["ownership"];
      let exitCode: number | null = null;
      let processSignal: string | null = null;
      let timedOut = false;
      let cancelledResult = false;

      for await (const event of this.runner.run({
        executionId: capsule.reviewRequestId,
        executablePath: snapshot.executablePath,
        args: buildClaudeReviewArgv(config),
        cwd: bundle.bundlePath,
        stdin: prepared.finalStdin,
        timeoutMs: config.timeoutSeconds * 1_000,
        maxOutputBytes: config.maximumOutputBytes,
        environment: this.environment
      }, controls.signal)) {
        if (event.type === "started") {
          ownership = event.ownership;
          // Report process-start to ReviewEngine before processing any
          // further output from this process, so the durable ReviewInvocation
          // row is CAS-transitioned PREPARING -> RUNNING under the exact
          // ownership/lease generation as early as possible. If ownership was
          // already lost, ReviewEngine has already aborted `controls.signal`
          // as part of this call -- the loop below observes that the same way
          // it observes any other abort (a cancelled exit event), so there is
          // nothing further to do here.
          await controls.markInvocationRunning?.({ pid: event.ownership.pid, processIdentity: event.ownership.processIdentity, startedAt: event.ownership.startedAt });
        }
        else if (event.type === "stdout") stdout += event.message;
        else if (event.type === "stderr") stderr += event.message;
        else if (event.type === "exit") {
          exitCode = event.result.exitCode;
          processSignal = event.result.signal;
          timedOut = event.result.timedOut;
          cancelledResult = event.result.cancelled;
        }
      }

      const finishedAt = controls.now().toISOString();
      const outcome: InvocationOutcome = { stdout, stderr, ownership, exitCode, processSignal, timedOut, cancelled: cancelledResult, finishedAt };

      // Fires unconditionally, before any parse/cancel/timeout branch below,
      // so a diagnostic observer always sees the exact raw bytes the process
      // produced -- regardless of whether the strict parser (or any other
      // check here) goes on to accept or reject them.
      if (this.onRawInvocationOutcome) {
        await this.onRawInvocationOutcome({ stdout, stderr, exitCode, signal: processSignal, timedOut, cancelled: cancelledResult });
      }

      if (cancelledResult) {
        await this.reportInvocation(controls, config, snapshot, prepared, outcome);
        throw controls.signal.reason ?? new DOMException("Review cancelled.", "AbortError");
      }
      if (timedOut) {
        await this.reportInvocation(controls, config, snapshot, prepared, outcome);
        throw new Error(`Claude CLI review timed out after ${config.timeoutSeconds} seconds.`);
      }

      const unchanged = await bundle.verifyUnchanged();
      if (!unchanged) {
        await this.reportInvocation(controls, config, snapshot, prepared, outcome);
        throw new Error("The disposable Claude review bundle was unexpectedly modified during the review; the result cannot be trusted.");
      }
      if (exitCode !== 0) {
        await this.reportInvocation(controls, config, snapshot, prepared, outcome);
        throw new Error(`Claude CLI exited with code ${exitCode ?? "unknown"}.`);
      }

      let verdict: StructuredReviewVerdict;
      try {
        verdict = this.allowBareVerdictTestDouble ? parseClaudeTestDoubleVerdict(stdout) : parseClaudeVerdict(stdout);
        // The wrapper/schema parse above already requires reviewedMaterialHash/
        // reviewedPromptHash to be present and well-formed for claude-cli (see
        // CLAUDE_VERDICT_JSON_SCHEMA); this is the independent runtime check
        // that what Claude echoed actually matches what was bound here, before
        // any invocation, never trusting the process's own compliance.
        if (verdict.reviewedMaterialHash !== materialHash) throw new Error("Claude CLI output does not echo the bound review material hash.");
        if (verdict.reviewedPromptHash !== promptHash) throw new Error("Claude CLI output does not echo the bound prompt hash.");
      } catch (error) {
        await this.reportInvocation(controls, config, snapshot, prepared, outcome);
        throw error;
      }

      await this.reportInvocation(controls, config, snapshot, prepared, { ...outcome, structuredOutputJson: JSON.stringify(verdict) });
      return verdict;
    } finally {
      await bundle.cleanup();
    }
  }

  async cancel(reviewRequestId: string): Promise<void> {
    this.cancelled.add(reviewRequestId);
    await this.runner.cancel(reviewRequestId);
  }

  async health(): Promise<ReviewerHealth> {
    const snapshot = await this.discovery.discover();
    return {
      healthy: snapshot.supported && snapshot.authenticationStatus === "AUTHENTICATED",
      checkedAt: snapshot.detectedAt,
      message: snapshot.authenticationStatus !== "AUTHENTICATED"
        ? `Claude CLI ${snapshot.version || "unknown"} is not authenticated with a subscription session.`
        : snapshot.supported ? `Claude CLI ${snapshot.version} is ready.` : snapshot.unsupportedReasons.join(" ")
    };
  }
}
