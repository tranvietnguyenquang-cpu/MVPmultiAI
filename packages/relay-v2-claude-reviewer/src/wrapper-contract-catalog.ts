/**
 * Explicit catalog binding each locally-verified Claude CLI version to the
 * exact real-CLI JSON transport wrapper shape `verdict-parser.ts` was built
 * and tested against. Deliberately NOT a semver range: a patch release is
 * never assumed to preserve the wrapper's shape, so only an exact version
 * string registered here is ever eligible to back an AUTHORITATIVE review.
 * Extending support to a new version requires adding an entry here only
 * after that version's wrapper output has actually been observed and
 * verified (mirroring how `claude-cli-v2-1-220-wrapper.fixture.ts` was
 * produced for 2.1.220) -- never by widening this catalog speculatively.
 */
export type ClaudeWrapperContract = {
  /** Stable identifier for the wrapper shape itself (not the CLI version) -- participates in the capability semantic hash, reviewerConfigJson, and ReviewInvocation so a request is always bound to one concrete, verified transport contract. */
  readonly contractId: string;
  /** Version of this repository's own parser logic for that contract, bumped whenever `verdict-parser.ts`'s handling of this contract changes. */
  readonly parserVersion: string;
};

export const SUPPORTED_CLAUDE_WRAPPER_CONTRACTS: Readonly<Record<string, ClaudeWrapperContract>> = Object.freeze({
  "2.1.220": Object.freeze({ contractId: "claude-json-schema-result-v1", parserVersion: "1" }),
  /**
   * Registered after an operator-run structural diagnostic
   * (`RELAY_V2_CLAUDE_ALLOW_UNREGISTERED_DIAGNOSTIC=1`) observed the real
   * 2.1.221 wrapper and proved it identical to the 2.1.220 contract: same
   * top-level key set, same field types within the contract's declared unions,
   * all five authority fields exactly as required, `result` and
   * `structured_output` each parsing to the strict verdict and canonically
   * equal, all three echoed hashes matching, and the UNCHANGED strict
   * production parser accepting the output. Same wrapper shape means the same
   * contract id and parser version -- and nothing more: 2.1.222 and every
   * other unobserved version remain unsupported, because this entry records
   * an observation, not a prediction about patch releases.
   */
  "2.1.221": Object.freeze({ contractId: "claude-json-schema-result-v1", parserVersion: "1" })
});

/** Every registered version, sorted, for messages and tests. Never a range — membership is exact-match only. */
export const SUPPORTED_CLAUDE_WRAPPER_VERSIONS: readonly string[] = Object.freeze(Object.keys(SUPPORTED_CLAUDE_WRAPPER_CONTRACTS).sort());

/** The version the wrapper schema and its sanitized fixture were originally modeled from. Documentation/provenance only — it confers no support of its own, and support is decided solely by exact catalog membership. */
export const CLAUDE_CLI_REFERENCE_WRAPPER_VERSION = "2.1.220" as const;

/**
 * Looks up the exact, currently-registered wrapper contract for a CLI
 * version string. Returns undefined for anything not an exact match --
 * older, newer (including untested patch releases like 2.1.221), unknown, or
 * unparseable version strings are all equally unsupported. Never a
 * semver-range or prefix match.
 */
export function resolveClaudeWrapperContract(cliVersion: string): ClaudeWrapperContract | undefined {
  return Object.prototype.hasOwnProperty.call(SUPPORTED_CLAUDE_WRAPPER_CONTRACTS, cliVersion)
    ? SUPPORTED_CLAUDE_WRAPPER_CONTRACTS[cliVersion]
    : undefined;
}

/**
 * The exact `unsupportedReasons` entry capability discovery records when a CLI
 * version has no registered wrapper contract.
 *
 * Built here rather than inline at the call site so a consumer can recognize
 * *this specific* reason by exact equality instead of matching on message
 * text. That matters for exactly one consumer: the operator-gated
 * unregistered-version structural diagnostic, which must run only when the
 * version being unregistered is the *sole* thing wrong with the CLI, and must
 * still refuse when the CLI is (say) unauthenticated or missing a required
 * flag. String-sniffing that distinction would silently start allowing more
 * than intended the first time this message is reworded.
 */
export function unregisteredWrapperContractReason(versionText: string): string {
  return `Claude CLI version '${versionText || "(unrecognized)"}' has no registered, locally-verified wrapper contract; only ${Object.keys(SUPPORTED_CLAUDE_WRAPPER_CONTRACTS).join(", ")} is currently supported.`;
}

/** The leading semver-shaped token of a `--version` output that may carry trailing decoration (e.g. `2.1.221 (Claude Code)`). Never a range or prefix match -- only this exact token is looked up in the catalog. */
export function claudeSemverToken(versionText: string): string | undefined {
  return /^(\d+\.\d+\.\d+)/.exec(versionText.trim())?.[1];
}
