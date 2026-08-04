import { canonicalJson, structuredReviewVerdictSchema } from "@project-relay/relay-v2-domain";
import {
  CLAUDE_WRAPPER_CONTRACT_FIELDS, CLAUDE_WRAPPER_CONTRACT_KEYS, parseClaudeVerdict
} from "./verdict-parser.js";

/**
 * Field-by-field comparison of an observed Claude CLI transport wrapper
 * against the verified `claude.exe` v2.1.220 contract.
 *
 * This exists so registering a new CLI version is a decision made from
 * evidence rather than from "it's only a patch release". It reports what
 * differs; it never decides that anything is supported, never writes to the
 * contract catalog, and is never consulted by the production parser. The
 * production parser (`parseClaudeVerdict`) remains the only thing that can
 * accept a wrapper for a real review, and it remains fail-closed.
 *
 * Deliberately reports SHAPE, not content: key sets, field types, the exact
 * authority-field literals, and whether parsing/equality/echo checks pass.
 * The verdict text itself is never included.
 */

export type WrapperFieldComparison = {
  field: string;
  /** Every type the registered strict schema accepts for this field, e.g. `string | null`. */
  expectedType: string;
  actualType: string;
  present: boolean;
  /** True when the observed type is any type the contract allows -- not merely the type one sample happened to have. */
  matches: boolean;
};

export type HashEchoResult = "MATCH" | "MISMATCH" | "ABSENT" | "NOT_APPLICABLE";

export type WrapperContractComparison = {
  comparedAgainst: string;
  parsedAsSingleJsonObject: boolean;
  parseError?: string;
  topLevelKeys: {
    expected: string[];
    actual: string[];
    missing: string[];
    unexpected: string[];
    identical: boolean;
  };
  fieldTypes: WrapperFieldComparison[];
  /** The exact literal values the production parser requires, reported as observed. */
  authorityFields: {
    type: unknown;
    subtype: unknown;
    is_error: unknown;
    api_error_status: unknown;
    permission_denials: { type: string; length: number | null };
    allExactlyAsRequired: boolean;
  };
  resultField: { present: boolean; type: string; parsesAsVerdict: boolean; parseError?: string };
  structuredOutputField: { present: boolean; type: string; parsesAsVerdict: boolean; parseError?: string };
  /** Null when either side failed to parse as a verdict at all. */
  resultAndStructuredOutputCanonicallyEqual: boolean | null;
  /** Whether the model copied the three hashes it was told to echo verbatim. */
  hashEcho: { requestHash: HashEchoResult; materialHash: HashEchoResult; promptHash: HashEchoResult };
  /** Whether the UNCHANGED production parser accepts this wrapper as-is. */
  strictProductionParser: { accepts: boolean; error?: string };
  /**
   * True only when every authority-relevant aspect is identical to the
   * verified 2.1.220 contract AND the unchanged strict parser accepts the
   * output. This is the single condition under which a new version may be
   * registered reusing the existing contract id and parser version; anything
   * else requires a distinct contract/parser and its own strict schema.
   */
  structurallyIdenticalToVerifiedContract: boolean;
};

function jsonTypeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function verdictParse(value: unknown): { ok: true; canonical: string; echo: Record<string, unknown> } | { ok: false; error: string } {
  const parsed = structuredReviewVerdictSchema.safeParse(value);
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map(issue => issue.message).join("; ") };
  return { ok: true, canonical: canonicalJson(parsed.data), echo: parsed.data as unknown as Record<string, unknown> };
}

function echoResult(actual: unknown, expected: string | undefined): HashEchoResult {
  if (expected === undefined) return "NOT_APPLICABLE";
  if (typeof actual !== "string" || actual.length === 0) return "ABSENT";
  return actual === expected ? "MATCH" : "MISMATCH";
}

export type WrapperComparisonInput = {
  rawStdout: string;
  /** The hashes the prompt told the model to echo, so the report can state whether it did. */
  expectedEcho?: { requestHash: string; materialHash: string; promptHash: string };
  comparedAgainst?: string;
};

export function compareWrapperToVerifiedContract(input: WrapperComparisonInput): WrapperContractComparison {
  // Expected types come from the registered contract's own field metadata, not
  // from a sample wrapper's values: a nullable telemetry field that happened
  // to be null in the fixture accepts `string | null`, and reporting the
  // sample's type as "the" expected type turned a valid observation into a
  // false contract violation.
  const expectedKeys = [...CLAUDE_WRAPPER_CONTRACT_KEYS];
  const comparedAgainst = input.comparedAgainst ?? "claude-json-schema-result-v1 (parser 1)";

  let observed: Record<string, unknown> | undefined;
  let parseError: string | undefined;
  try {
    const value: unknown = JSON.parse(input.rawStdout.trim());
    if (value && typeof value === "object" && !Array.isArray(value)) observed = value as Record<string, unknown>;
    else parseError = `stdout parsed as ${jsonTypeOf(value)}, not a JSON object`;
  } catch (error) {
    parseError = error instanceof Error ? error.message : String(error);
  }

  const strictAttempt = ((): { accepts: boolean; error?: string } => {
    try {
      parseClaudeVerdict(input.rawStdout);
      return { accepts: true };
    } catch (error) {
      return { accepts: false, error: error instanceof Error ? error.message : String(error) };
    }
  })();

  if (!observed) {
    return {
      comparedAgainst,
      parsedAsSingleJsonObject: false,
      ...(parseError ? { parseError } : {}),
      topLevelKeys: { expected: expectedKeys, actual: [], missing: expectedKeys, unexpected: [], identical: false },
      fieldTypes: [],
      authorityFields: {
        type: undefined, subtype: undefined, is_error: undefined, api_error_status: undefined,
        permission_denials: { type: "absent", length: null }, allExactlyAsRequired: false
      },
      resultField: { present: false, type: "absent", parsesAsVerdict: false },
      structuredOutputField: { present: false, type: "absent", parsesAsVerdict: false },
      resultAndStructuredOutputCanonicallyEqual: null,
      hashEcho: { requestHash: "ABSENT", materialHash: "ABSENT", promptHash: "ABSENT" },
      strictProductionParser: strictAttempt,
      structurallyIdenticalToVerifiedContract: false
    };
  }

  const actualKeys = Object.keys(observed).sort();
  const missing = expectedKeys.filter(key => !actualKeys.includes(key));
  const unexpected = actualKeys.filter(key => !expectedKeys.includes(key));

  const fieldTypes: WrapperFieldComparison[] = expectedKeys.map(field => {
    const contract = CLAUDE_WRAPPER_CONTRACT_FIELDS[field]!;
    const present = Object.prototype.hasOwnProperty.call(observed, field);
    const actualType = present ? jsonTypeOf(observed[field]) : "absent";
    return {
      field,
      expectedType: contract.allowedTypes.join(" | "),
      actualType,
      present,
      matches: present && contract.allowedTypes.includes(actualType as never)
    };
  });

  const denials = observed.permission_denials;
  const authorityFields = {
    type: observed.type,
    subtype: observed.subtype,
    is_error: observed.is_error,
    api_error_status: observed.api_error_status,
    permission_denials: { type: jsonTypeOf(denials), length: Array.isArray(denials) ? denials.length : null },
    allExactlyAsRequired:
      observed.type === "result" && observed.subtype === "success" && observed.is_error === false
      && observed.api_error_status === null && Array.isArray(denials) && denials.length === 0
  };

  const resultRaw = observed.result;
  let resultParsed: ReturnType<typeof verdictParse> | undefined;
  if (typeof resultRaw === "string") {
    try {
      resultParsed = verdictParse(JSON.parse(resultRaw));
    } catch (error) {
      resultParsed = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  const structuredParsed = observed.structured_output === undefined ? undefined : verdictParse(observed.structured_output);

  const resultField = {
    present: Object.prototype.hasOwnProperty.call(observed, "result"),
    type: jsonTypeOf(resultRaw),
    parsesAsVerdict: resultParsed?.ok === true,
    ...(resultParsed && !resultParsed.ok ? { parseError: resultParsed.error } : {})
  };
  const structuredOutputField = {
    present: Object.prototype.hasOwnProperty.call(observed, "structured_output"),
    type: jsonTypeOf(observed.structured_output),
    parsesAsVerdict: structuredParsed?.ok === true,
    ...(structuredParsed && !structuredParsed.ok ? { parseError: structuredParsed.error } : {})
  };

  const canonicallyEqual = resultParsed?.ok && structuredParsed?.ok
    ? resultParsed.canonical === structuredParsed.canonical
    : null;

  const echoSource = structuredParsed?.ok ? structuredParsed.echo : resultParsed?.ok ? resultParsed.echo : undefined;
  const hashEcho = {
    requestHash: echoResult(echoSource?.reviewedRequestHash, input.expectedEcho?.requestHash),
    materialHash: echoResult(echoSource?.reviewedMaterialHash, input.expectedEcho?.materialHash),
    promptHash: echoResult(echoSource?.reviewedPromptHash, input.expectedEcho?.promptHash)
  };

  const echoAcceptable = Object.values(hashEcho).every(value => value === "MATCH" || value === "NOT_APPLICABLE");

  return {
    comparedAgainst,
    parsedAsSingleJsonObject: true,
    topLevelKeys: { expected: expectedKeys, actual: actualKeys, missing, unexpected, identical: missing.length === 0 && unexpected.length === 0 },
    fieldTypes,
    authorityFields,
    resultField,
    structuredOutputField,
    resultAndStructuredOutputCanonicallyEqual: canonicallyEqual,
    hashEcho,
    strictProductionParser: strictAttempt,
    structurallyIdenticalToVerifiedContract:
      missing.length === 0 && unexpected.length === 0
      && fieldTypes.every(entry => entry.matches)
      && authorityFields.allExactlyAsRequired
      && canonicallyEqual === true
      && echoAcceptable
      && strictAttempt.accepts
  };
}
