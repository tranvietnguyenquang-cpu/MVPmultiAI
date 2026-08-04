import { describe, expect, it } from "vitest";
import type { ReviewerCapabilityDiagnostic } from "@project-relay/relay-v2-domain";
import { buildClaudeReviewerConfig, ClaudeReviewerUnavailableError } from "./build-claude-reviewer-config.js";

function diagnostic(overrides: Partial<ReviewerCapabilityDiagnostic> = {}): ReviewerCapabilityDiagnostic {
  return {
    reviewerId: "claude-cli", displayPath: "claude.exe", version: "2.1.220",
    authenticationStatus: "AUTHENTICATED", authenticationEvidence: "CLAUDE_AUTH_STATUS_JSON",
    supported: true, unsupportedReasons: [], executableIdentityHash: "a".repeat(64), helpHash: "b".repeat(64),
    wrapperContractId: "claude-json-schema-result-v1", wrapperParserVersion: "1",
    detectedAt: "2026-08-03T00:00:00.000Z", expiresAt: "2026-08-03T00:05:00.000Z", ...overrides
  };
}

describe("buildClaudeReviewerConfig", () => {
  it("builds a fully server-derived, strictly valid config from a fresh diagnostic", () => {
    const config = buildClaudeReviewerConfig(diagnostic(), "77777777-7777-7777-7777-777777777777", { now: new Date("2026-08-03T00:01:00.000Z") });
    expect(config).toMatchObject({
      reviewerId: "claude-cli", model: "AUTO", capabilitySnapshotId: "77777777-7777-7777-7777-777777777777", cliVersion: "2.1.220", executableIdentityHash: "a".repeat(64),
      wrapperContractId: "claude-json-schema-result-v1", wrapperParserVersion: "1"
    });
  });

  it("rejects a diagnostic with no resolved wrapper contract, even if otherwise supported and authenticated", () => {
    expect(() => buildClaudeReviewerConfig(diagnostic({ wrapperContractId: "" }), "77777777-7777-7777-7777-777777777777")).toThrow(ClaudeReviewerUnavailableError);
    expect(() => buildClaudeReviewerConfig(diagnostic({ wrapperParserVersion: "" }), "77777777-7777-7777-7777-777777777777")).toThrow(ClaudeReviewerUnavailableError);
  });

  it("rejects an unsupported diagnostic", () => {
    expect(() => buildClaudeReviewerConfig(diagnostic({ supported: false, unsupportedReasons: ["x"] }), "77777777-7777-7777-7777-777777777777")).toThrow(ClaudeReviewerUnavailableError);
  });

  it("rejects an unauthenticated diagnostic", () => {
    expect(() => buildClaudeReviewerConfig(diagnostic({ authenticationStatus: "UNAUTHENTICATED" }), "77777777-7777-7777-7777-777777777777")).toThrow(ClaudeReviewerUnavailableError);
  });

  it("rejects an expired diagnostic", () => {
    expect(() => buildClaudeReviewerConfig(diagnostic(), "77777777-7777-7777-7777-777777777777", { now: new Date("2026-08-03T01:00:00.000Z") })).toThrow(/expired/);
  });
});
