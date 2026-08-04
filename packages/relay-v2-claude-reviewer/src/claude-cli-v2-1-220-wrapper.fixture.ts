/**
 * Sanitized fixture of the real `claude.exe` v2.1.220
 * (`-p --output-format json --json-schema <schema>`) transport wrapper,
 * observed from a real, sanitized local invocation. Top-level key names,
 * field types, and the exact `structured_output`/`result` schema are
 * preserved; every value is a deterministic placeholder -- no real
 * session_id/uuid/usage/cost/timing/auth/task content. See
 * docs/CLAUDE_REVIEWER.md's "Structured output" section for provenance.
 */
import type { StructuredReviewVerdict } from "@project-relay/relay-v2-domain";

const REVIEWED_REQUEST_HASH = "1".repeat(64);
const REVIEWED_MATERIAL_HASH = "2".repeat(64);
const REVIEWED_PROMPT_HASH = "3".repeat(64);

export const CLAUDE_CLI_V2_1_220_FIXTURE_HASHES = {
  reviewedRequestHash: REVIEWED_REQUEST_HASH,
  reviewedMaterialHash: REVIEWED_MATERIAL_HASH,
  reviewedPromptHash: REVIEWED_PROMPT_HASH
} as const;

export function claudeCliV2_1_220SampleVerdict(overrides: Partial<StructuredReviewVerdict> = {}): StructuredReviewVerdict {
  return {
    reviewedRequestHash: REVIEWED_REQUEST_HASH,
    reviewedMaterialHash: REVIEWED_MATERIAL_HASH,
    reviewedPromptHash: REVIEWED_PROMPT_HASH,
    verdict: "APPROVE",
    summary: "Sanitized fixture verdict.",
    findings: [],
    requiredActions: [],
    confidence: 1,
    reviewerVersion: "claude-cli-v2.1.220-fixture@1",
    ...overrides
  };
}

/**
 * The full sanitized wrapper, keyed exactly as observed (21 top-level keys):
 * type, subtype, is_error, api_error_status, result, structured_output,
 * permission_denials, session_id, uuid, duration_ms, duration_api_ms,
 * time_to_request_ms, ttft_ms, ttft_stream_ms, num_turns, total_cost_usd,
 * usage, modelUsage, fast_mode_state, fast_mode_disabled_reason, stop_reason,
 * terminal_reason.
 */
export function claudeCliV2_1_220WrapperFixture(
  verdict: StructuredReviewVerdict = claudeCliV2_1_220SampleVerdict(),
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    api_error_status: null,
    result: JSON.stringify(verdict),
    structured_output: verdict,
    permission_denials: [],
    session_id: "00000000-0000-4000-8000-000000000000",
    uuid: "00000000-0000-4000-8000-000000000001",
    duration_ms: 4321,
    duration_api_ms: 4000,
    time_to_request_ms: 12,
    ttft_ms: 500,
    ttft_stream_ms: 520,
    num_turns: 1,
    total_cost_usd: 0.01,
    usage: { input_tokens: 100, output_tokens: 50 },
    modelUsage: { "claude-sample-model": { input_tokens: 100, output_tokens: 50 } },
    fast_mode_state: "disabled",
    fast_mode_disabled_reason: null,
    stop_reason: "end_turn",
    terminal_reason: null,
    ...overrides
  };
}
