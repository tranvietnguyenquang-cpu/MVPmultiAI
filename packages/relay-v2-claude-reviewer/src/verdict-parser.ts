import { z } from "zod";
import { canonicalJson, structuredReviewVerdictSchema, type StructuredReviewVerdict } from "@project-relay/relay-v2-domain";
import { CLAUDE_CLI_REFERENCE_WRAPPER_VERSION, SUPPORTED_CLAUDE_WRAPPER_VERSIONS } from "./wrapper-contract-catalog.js";

export class ClaudeVerdictParseError extends Error {}

/** The exact real-CLI transport wrapper versions this parser accepts, re-exported from the single-source-of-truth catalog (`wrapper-contract-catalog.ts`) so this file and capability discovery can never drift apart. Add a catalog entry — and, if the wrapper shape itself changed, a new contract id/parser version with its own schema — only after that version's output has actually been observed and verified. */
export { CLAUDE_CLI_REFERENCE_WRAPPER_VERSION, SUPPORTED_CLAUDE_WRAPPER_VERSIONS };

const opaqueTelemetryObjectSchema = z.record(z.string(), z.unknown());

/**
 * The real `claude.exe` v2.1.220 (`-p --output-format json --json-schema <schema>`)
 * transport wrapper, modeled from a real, sanitized local invocation captured
 * by the structural diagnostic harness (see docs/CLAUDE_REVIEWER.md's
 * "Structured output" section) -- not from this repository's unrelated
 * `stream-json` parser, which an earlier pass of this file incorrectly used as
 * a model. `type`/`subtype`/`is_error`/`api_error_status`/`permission_denials`
 * are authority fields: only exactly `"result"`/`"success"`/`false`/
 * `null`/`[]` respectively are ever accepted, never merely truthy/falsy
 * checked after the fact. `result` is always a JSON string (never an object)
 * in the real wrapper; `structured_output` is always an object.
 *
 * Every other field here (session/uuid/usage/modelUsage/cost/timing/fast-mode/
 * stop-reason/terminal-reason) is bounded, opaque telemetry: validated for
 * shape only, so a malformed telemetry field still fails closed, but never
 * read, logged, persisted, exposed, or used as verdict authority by this
 * parser or its caller. Unknown top-level fields are rejected (`.strict()`):
 * a future CLI version that adds, removes, or reshapes any field fails this
 * schema and becomes ERROR, never a silently accepted unknown wrapper -- a
 * new capability/diagnostic snapshot and a re-verified wrapper shape are
 * required before that version can back an AUTHORITATIVE review again.
 */
const claudeCliRealTransportWrapperSchema = z.object({
  type: z.literal("result"),
  subtype: z.literal("success"),
  is_error: z.literal(false),
  api_error_status: z.null(),
  result: z.string().min(1),
  structured_output: z.record(z.string(), z.unknown()),
  permission_denials: z.array(z.unknown()).length(0),
  session_id: z.string().min(1).max(200),
  uuid: z.string().min(1).max(200),
  duration_ms: z.number(),
  duration_api_ms: z.number(),
  time_to_request_ms: z.number(),
  ttft_ms: z.number(),
  ttft_stream_ms: z.number(),
  num_turns: z.number(),
  total_cost_usd: z.number(),
  usage: opaqueTelemetryObjectSchema,
  modelUsage: opaqueTelemetryObjectSchema,
  fast_mode_state: z.string().min(1).max(100),
  fast_mode_disabled_reason: z.union([z.string().max(500), z.null()]),
  stop_reason: z.union([z.string().max(200), z.null()]),
  terminal_reason: z.union([z.string().max(200), z.null()])
}).strict();

/** The JSON type names the wrapper contract is described in. */
export type WrapperJsonTypeName = "null" | "boolean" | "number" | "string" | "array" | "object";

export type WrapperFieldContract = {
  /** Every JSON type the strict schema above accepts for this field. */
  readonly allowedTypes: readonly WrapperJsonTypeName[];
  /** Set only for the authority fields, whose value must be exactly this — never merely the right type. */
  readonly exactValue?: unknown;
  /** True for the five fields whose values carry review authority; the rest are opaque telemetry or content. */
  readonly authority: boolean;
};

/**
 * The contract that `claudeCliRealTransportWrapperSchema` enforces, stated as
 * explicit metadata.
 *
 * This exists because a *sample* of a wrapper is not a description of one. The
 * structural comparator originally derived expected field types from the
 * fixture's values, so `fast_mode_disabled_reason: null` in the sample made a
 * perfectly valid observed `string` look like a contract violation — the
 * comparator was describing one observed run rather than the accepted union.
 * Nullable telemetry fields genuinely accept `string | null`, and this table
 * says so.
 *
 * It is kept beside the schema deliberately, and `verdict-parser.test.ts`
 * probes the real schema with a representative value of every JSON type for
 * every field and requires the results to match this table exactly — so the
 * two cannot drift into disagreement without a test failing. It describes the
 * schema; it never relaxes it, and nothing parses through it.
 */
export const CLAUDE_WRAPPER_CONTRACT_FIELDS: Readonly<Record<string, WrapperFieldContract>> = Object.freeze({
  // --- authority fields: exact values, never merely the right type ---------
  type: Object.freeze({ allowedTypes: Object.freeze(["string"]) as readonly WrapperJsonTypeName[], exactValue: "result", authority: true }),
  subtype: Object.freeze({ allowedTypes: Object.freeze(["string"]) as readonly WrapperJsonTypeName[], exactValue: "success", authority: true }),
  is_error: Object.freeze({ allowedTypes: Object.freeze(["boolean"]) as readonly WrapperJsonTypeName[], exactValue: false, authority: true }),
  api_error_status: Object.freeze({ allowedTypes: Object.freeze(["null"]) as readonly WrapperJsonTypeName[], exactValue: null, authority: true }),
  permission_denials: Object.freeze({ allowedTypes: Object.freeze(["array"]) as readonly WrapperJsonTypeName[], exactValue: [], authority: true }),
  // --- content fields ------------------------------------------------------
  result: Object.freeze({ allowedTypes: Object.freeze(["string"]) as readonly WrapperJsonTypeName[], authority: false }),
  structured_output: Object.freeze({ allowedTypes: Object.freeze(["object"]) as readonly WrapperJsonTypeName[], authority: false }),
  // --- opaque, shape-validated telemetry -----------------------------------
  session_id: Object.freeze({ allowedTypes: Object.freeze(["string"]) as readonly WrapperJsonTypeName[], authority: false }),
  uuid: Object.freeze({ allowedTypes: Object.freeze(["string"]) as readonly WrapperJsonTypeName[], authority: false }),
  duration_ms: Object.freeze({ allowedTypes: Object.freeze(["number"]) as readonly WrapperJsonTypeName[], authority: false }),
  duration_api_ms: Object.freeze({ allowedTypes: Object.freeze(["number"]) as readonly WrapperJsonTypeName[], authority: false }),
  time_to_request_ms: Object.freeze({ allowedTypes: Object.freeze(["number"]) as readonly WrapperJsonTypeName[], authority: false }),
  ttft_ms: Object.freeze({ allowedTypes: Object.freeze(["number"]) as readonly WrapperJsonTypeName[], authority: false }),
  ttft_stream_ms: Object.freeze({ allowedTypes: Object.freeze(["number"]) as readonly WrapperJsonTypeName[], authority: false }),
  num_turns: Object.freeze({ allowedTypes: Object.freeze(["number"]) as readonly WrapperJsonTypeName[], authority: false }),
  total_cost_usd: Object.freeze({ allowedTypes: Object.freeze(["number"]) as readonly WrapperJsonTypeName[], authority: false }),
  usage: Object.freeze({ allowedTypes: Object.freeze(["object"]) as readonly WrapperJsonTypeName[], authority: false }),
  modelUsage: Object.freeze({ allowedTypes: Object.freeze(["object"]) as readonly WrapperJsonTypeName[], authority: false }),
  fast_mode_state: Object.freeze({ allowedTypes: Object.freeze(["string"]) as readonly WrapperJsonTypeName[], authority: false }),
  // Verified nullable telemetry: a real run reports either a reason string or
  // null for each of these, and both are accepted.
  fast_mode_disabled_reason: Object.freeze({ allowedTypes: Object.freeze(["string", "null"]) as readonly WrapperJsonTypeName[], authority: false }),
  stop_reason: Object.freeze({ allowedTypes: Object.freeze(["string", "null"]) as readonly WrapperJsonTypeName[], authority: false }),
  terminal_reason: Object.freeze({ allowedTypes: Object.freeze(["string", "null"]) as readonly WrapperJsonTypeName[], authority: false })
});

/** Every top-level key the contract declares. Unknown keys remain rejected by the schema's `.strict()`. */
export const CLAUDE_WRAPPER_CONTRACT_KEYS: readonly string[] = Object.freeze(Object.keys(CLAUDE_WRAPPER_CONTRACT_FIELDS).sort());

/** Exposed ONLY so the contract-metadata drift test can probe the real schema; never a parsing entry point. */
export function wrapperSchemaAcceptsForContractTest(candidate: unknown): boolean {
  return claudeCliRealTransportWrapperSchema.safeParse(candidate).success;
}

function parseExactlyOneJsonValue(text: string): { ok: true; value: unknown } | { ok: false } {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false };
  // Reject Markdown code fences outright (never stripped): a compliant
  // `--output-format json`/`--json-schema` invocation never wraps its JSON in
  // fences, so their presence means the output does not match the expected
  // wrapper and must be rejected, not "recovered" from.
  if (trimmed.includes("```")) return { ok: false };
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return { ok: false };
  }
  // JSON.parse only ever returns one value for the whole string (trailing
  // garbage after a complete value is a syntax error), so "two or more
  // top-level JSON objects" and "prose before/after the object" are both
  // already rejected by the strict JSON.parse above -- no separate
  // prose-scanning or duplicate-object recovery step exists in this parser.
  return { ok: true, value };
}

function parseStrictInnerVerdict(value: unknown, sourceLabel: string): StructuredReviewVerdict {
  const verdict = structuredReviewVerdictSchema.safeParse(value);
  if (!verdict.success) {
    throw new ClaudeVerdictParseError(`Claude CLI's ${sourceLabel} did not match the required structured verdict schema: ${verdict.error.issues.map(issue => issue.message).join("; ")}`);
  }
  return verdict.data;
}

/**
 * Strictly parses the real Claude CLI's stdout into exactly one validated
 * StructuredReviewVerdict. This is the production parser: it recognizes
 * exactly one shape, the real transport wrapper
 * (`claudeCliRealTransportWrapperSchema`), and never falls back to any other
 * interpretation on failure.
 *
 * `result` (a JSON string) and `structured_output` (an object) are each
 * independently parsed against the same strict inner verdict schema, then
 * canonicalized and required to be equal -- a wrapper that presents a
 * different object in each field is rejected, never resolved by trusting one
 * side over the other. `structured_output` is returned as the authoritative
 * value once equality is proven.
 *
 * No Markdown fences, no prose before/after the JSON, no duplicate JSON
 * objects, and no unknown wrapper or verdict field are ever accepted. Any
 * failure throws; the caller must turn that into a review ERROR, never an
 * APPROVE.
 */
export function parseClaudeVerdict(rawStdout: string): StructuredReviewVerdict {
  const outer = parseExactlyOneJsonValue(rawStdout);
  if (!outer.ok) throw new ClaudeVerdictParseError("Claude CLI output was not exactly one well-formed JSON value with no surrounding text or code fences.");

  const wrapper = claudeCliRealTransportWrapperSchema.safeParse(outer.value);
  if (!wrapper.success) {
    throw new ClaudeVerdictParseError(`Claude CLI output did not match the supported real transport wrapper (claude.exe v${SUPPORTED_CLAUDE_WRAPPER_VERSIONS.join(", v")}): ${wrapper.error.issues.map(issue => issue.message).join("; ")}`);
  }

  const resultInner = parseExactlyOneJsonValue(wrapper.data.result);
  if (!resultInner.ok) throw new ClaudeVerdictParseError("Claude CLI's result field was not exactly one well-formed JSON value with no surrounding text or code fences.");

  const fromResult = parseStrictInnerVerdict(resultInner.value, "result field");
  const fromStructuredOutput = parseStrictInnerVerdict(wrapper.data.structured_output, "structured_output field");

  if (canonicalJson(fromResult) !== canonicalJson(fromStructuredOutput)) {
    throw new ClaudeVerdictParseError("Claude CLI's result and structured_output fields did not contain the canonically equivalent verdict.");
  }

  return fromStructuredOutput;
}

/**
 * Bare-inner-verdict-only parser: the schema-constrained verdict object with
 * no transport wrapper at all. Never used on the production real-CLI path
 * (`parseClaudeVerdict` above never falls back to this on failure) -- reachable
 * only through the Claude CLI browser/Playwright process test double (see
 * `apps/web/lib/relay-v2/claude-reviewer-test-double.ts`), which is itself
 * gated behind `PROJECT_RELAY_TEST_MODE=true` AND `RELAY_V2_CLAUDE_TEST_DOUBLE=true`
 * AND a `playwright-v2`-containing `RELAY_V2_DATA_DIR`. A real Claude
 * invocation can never reach this function.
 */
export function parseClaudeTestDoubleVerdict(rawStdout: string): StructuredReviewVerdict {
  const outer = parseExactlyOneJsonValue(rawStdout);
  if (!outer.ok) throw new ClaudeVerdictParseError("Claude CLI test-double output was not exactly one well-formed JSON value with no surrounding text or code fences.");
  return parseStrictInnerVerdict(outer.value, "test-double output");
}
