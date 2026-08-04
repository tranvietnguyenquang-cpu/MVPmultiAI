import { claudeReviewerConfigSchema, type ClaudeReviewerConfig, type ReviewerCapabilityDiagnostic } from "@project-relay/relay-v2-domain";
import { capabilitySemanticHash } from "./claude-capabilities.js";

export class ClaudeReviewerUnavailableError extends Error {}

/**
 * Server-side-only construction of a full ClaudeReviewerConfig from a
 * currently fresh, supported, authenticated capability diagnostic. Client
 * requests never supply capabilitySnapshotId/executableIdentityHash/
 * cliVersion directly -- those always come from the server's own freshly
 * (re)verified diagnostic, so a request can never bind to an executable the
 * caller merely claims exists.
 */
export function buildClaudeReviewerConfig(
  diagnostic: ReviewerCapabilityDiagnostic,
  capabilitySnapshotId: string,
  overrides: { timeoutSeconds?: number; now?: Date } = {}
): ClaudeReviewerConfig {
  if (!diagnostic.supported) throw new ClaudeReviewerUnavailableError(`Claude CLI is not currently supported: ${diagnostic.unsupportedReasons.join(" ") || "unknown reason"}.`);
  if (diagnostic.authenticationStatus !== "AUTHENTICATED") throw new ClaudeReviewerUnavailableError("Claude CLI is not authenticated with a subscription session.");
  // A supported+authenticated diagnostic should always carry a resolved
  // wrapper contract (discovery's own unsupportedReasons check already
  // requires one), but this is re-asserted here, independently, as the one
  // place every claude-cli ReviewRequest's binding is actually constructed --
  // an unsupported/unresolved contract must block request creation itself,
  // not just the later live pre-spawn check.
  if (!diagnostic.wrapperContractId || !diagnostic.wrapperParserVersion) {
    throw new ClaudeReviewerUnavailableError("Claude CLI has no registered, locally-verified wrapper contract for this version; refusing to bind a review request.");
  }
  const now = overrides.now ?? new Date();
  if (new Date(diagnostic.expiresAt).getTime() <= now.getTime()) {
    throw new ClaudeReviewerUnavailableError("The Claude CLI capability snapshot has expired; refresh diagnostics before requesting a review.");
  }
  return claudeReviewerConfigSchema.parse({
    reviewerId: "claude-cli",
    model: "AUTO",
    reasoningOrEffort: "AUTO",
    timeoutSeconds: overrides.timeoutSeconds ?? 600,
    outputSchemaVersion: "claude-verdict-v1",
    materializerVersion: "claude-materializer-v1",
    promptPolicyVersion: "claude-prompt-policy-v1",
    wrapperContractId: diagnostic.wrapperContractId,
    wrapperParserVersion: diagnostic.wrapperParserVersion,
    capabilitySnapshotId,
    capabilitySnapshotHash: capabilitySemanticHash(diagnostic),
    executableIdentityHash: diagnostic.executableIdentityHash,
    cliVersion: diagnostic.version,
    readOnlyPolicy: "DENY_ALL_TOOLS",
    toolPolicy: "TOOLS_EMPTY_STRING",
    configurationIsolationPolicy: "SAFE_MODE_STRICT_MCP_NO_SESSION_NO_SLASH_COMMANDS",
    artifactSelectionPolicy: "BOUND_CAPSULE_ONLY",
    maximumInputBytes: 500_000,
    maximumOutputBytes: 2_000_000,
    materialBudgetVersion: "material-budget-v1"
  });
}
