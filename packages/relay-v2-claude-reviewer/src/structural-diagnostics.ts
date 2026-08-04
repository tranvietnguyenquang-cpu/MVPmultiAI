/**
 * Sanitized, bounded, read-only structural analysis of one real Claude CLI
 * invocation's raw stdout/stderr. Purely observational: never used by
 * `verdict-parser.ts` and never changes what a real review accepts or
 * rejects. Exists only so an operator running the opt-in real smoke
 * (`RELAY_V2_REAL_CLAUDE_REVIEW_SMOKE=1` + `RELAY_V2_CLAUDE_SMOKE_DIAGNOSTIC=1`)
 * can see the real CLI's exact transport shape -- keys, nesting, and value
 * *types* -- without printing prompt/evidence/credential content, so the
 * strict parser can be updated from verified fact rather than guesswork.
 */

const SENSITIVE_KEY_PATTERN = /email|account|organi[sz]ation|org[_-]?id|session[_-]?id|user|path|cwd|home|token|credential|cost|usage/i;
const CONTENT_CARRYING_KEYS = new Set(["result", "content", "structuredoutput"]);
// eslint-disable-next-line no-control-regex -- intentionally detects raw control/ANSI bytes in CLI output.
const CONTROL_OR_ANSI_PATTERN = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]|\x1B\[[0-9;]*[a-zA-Z]/;
const MAX_SUMMARY_DEPTH = 3;
const MAX_SAMPLE_LENGTH = 64;

export type JsonType = "null" | "boolean" | "number" | "string" | "array" | "object";

export type EmbeddedJsonSummary =
  | { parseable: false }
  | { parseable: true; jsonType: JsonType; keys?: string[]; fieldTypes?: Record<string, string> };

export type FieldTypeSummary =
  | { type: "null" }
  | { type: "boolean"; value?: boolean }
  | { type: "number"; value?: number }
  | { type: "string"; length: number; sample?: string; embeddedJson?: EmbeddedJsonSummary }
  | { type: "array"; length: number }
  | { type: "object"; keys: string[]; fields?: Record<string, FieldTypeSummary> }
  | { type: "redacted"; originalType: string };

export type RawInvocationStructuralReport = {
  process: { exitCode: number | null; signal: string | null; timedOut: boolean };
  stdout: {
    byteCount: number;
    nonEmptyLineCount: number;
    containsAnsiOrControlChars: boolean;
    isValidSingleJsonValue: boolean;
    topLevelJsonType: JsonType | "not-json";
    topLevelKeys?: string[];
    fields?: Record<string, FieldTypeSummary>;
    multipleJsonValuesDetected: boolean;
    jsonlRecordCount?: number;
  };
  stderr: {
    byteCount: number;
    nonEmptyLineCount: number;
    containsAnsiOrControlChars: boolean;
  };
};

function jsonTypeOf(value: unknown): JsonType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value as JsonType;
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key.toLowerCase());
}

function isContentCarryingKey(key: string): boolean {
  return CONTENT_CARRYING_KEYS.has(key.toLowerCase().replace(/[_-]/g, ""));
}

function detectEmbeddedJson(value: string): EmbeddedJsonSummary {
  const trimmed = value.trim();
  if (!trimmed || (trimmed[0] !== "{" && trimmed[0] !== "[")) return { parseable: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { parseable: false };
  }
  const jsonType = jsonTypeOf(parsed);
  if (jsonType !== "object") return { parseable: true, jsonType };
  const keys = Object.keys(parsed as Record<string, unknown>).sort();
  const fieldTypes: Record<string, string> = {};
  for (const key of keys) {
    fieldTypes[key] = isSensitiveKey(key) ? "redacted" : jsonTypeOf((parsed as Record<string, unknown>)[key]);
  }
  return { parseable: true, jsonType, keys, fieldTypes };
}

function summarizeValue(key: string, value: unknown, depth: number): FieldTypeSummary {
  if (value === null) return { type: "null" };
  const sensitive = isSensitiveKey(key);
  if (typeof value === "boolean") return sensitive ? { type: "redacted", originalType: "boolean" } : { type: "boolean", value };
  if (typeof value === "number") return sensitive ? { type: "redacted", originalType: "number" } : { type: "number", value };
  if (typeof value === "string") {
    if (sensitive) return { type: "redacted", originalType: "string" };
    const summary: FieldTypeSummary = { type: "string", length: value.length, embeddedJson: detectEmbeddedJson(value) };
    if (!isContentCarryingKey(key) && value.length <= MAX_SAMPLE_LENGTH) summary.sample = value;
    return summary;
  }
  if (Array.isArray(value)) return { type: "array", length: value.length };
  if (typeof value === "object") {
    if (sensitive) return { type: "redacted", originalType: "object" };
    const keys = Object.keys(value as Record<string, unknown>).sort();
    if (depth >= MAX_SUMMARY_DEPTH) return { type: "object", keys };
    const fields: Record<string, FieldTypeSummary> = {};
    for (const nestedKey of keys) fields[nestedKey] = summarizeValue(nestedKey, (value as Record<string, unknown>)[nestedKey], depth + 1);
    return { type: "object", keys, fields };
  }
  return { type: "redacted", originalType: typeof value };
}

function containsAnsiOrControl(text: string): boolean {
  return CONTROL_OR_ANSI_PATTERN.test(text);
}

function nonEmptyLines(text: string): string[] {
  return text.split("\n").map(line => line.trim()).filter(line => line.length > 0);
}

/**
 * Counts complete top-level JSON values found back-to-back in `text`
 * (whitespace-separated), stopping at the first byte that cannot extend a
 * value. Used only to report "did stdout contain more than one JSON value" --
 * never to pick one of several values as the answer.
 */
function countTopLevelJsonValues(text: string): number {
  let count = 0;
  let i = 0;
  const n = text.length;
  while (i < n) {
    while (i < n && /\s/.test(text[i]!)) i++;
    if (i >= n) break;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let matched = false;
    for (; i < n; i++) {
      const ch = text[i]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        if (depth === 0) matched = true;
        continue;
      }
      if (ch === "{" || ch === "[") {
        depth++;
        matched = true;
      } else if (ch === "}" || ch === "]") {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      } else if (depth === 0) {
        if (/\s/.test(ch)) break;
        matched = true;
      }
    }
    if (!matched) break;
    count++;
    if (depth > 0) break; // unterminated container -- stop scanning, nothing more to count reliably
  }
  return count;
}

export function buildRawInvocationStructuralReport(input: {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
}): RawInvocationStructuralReport {
  const trimmedStdout = input.stdout.trim();
  const stdoutLines = nonEmptyLines(input.stdout);
  const stderrLines = nonEmptyLines(input.stderr);

  let isValidSingleJsonValue = false;
  let topLevelJsonType: JsonType | "not-json" = "not-json";
  let topLevelKeys: string[] | undefined;
  let fields: Record<string, FieldTypeSummary> | undefined;

  if (trimmedStdout) {
    try {
      const parsed: unknown = JSON.parse(trimmedStdout);
      isValidSingleJsonValue = true;
      topLevelJsonType = jsonTypeOf(parsed);
      if (topLevelJsonType === "object") {
        topLevelKeys = Object.keys(parsed as Record<string, unknown>).sort();
        fields = {};
        for (const key of topLevelKeys) fields[key] = summarizeValue(key, (parsed as Record<string, unknown>)[key], 1);
      }
    } catch {
      isValidSingleJsonValue = false;
    }
  }

  let jsonlRecordCount: number | undefined;
  if (!isValidSingleJsonValue && stdoutLines.length > 1) {
    const allParse = stdoutLines.every(line => {
      try {
        JSON.parse(line);
        return true;
      } catch {
        return false;
      }
    });
    if (allParse) jsonlRecordCount = stdoutLines.length;
  }

  const multipleJsonValuesDetected = trimmedStdout.length > 0 && countTopLevelJsonValues(trimmedStdout) > 1;

  return {
    process: { exitCode: input.exitCode, signal: input.signal, timedOut: input.timedOut },
    stdout: {
      byteCount: Buffer.byteLength(input.stdout, "utf8"),
      nonEmptyLineCount: stdoutLines.length,
      containsAnsiOrControlChars: containsAnsiOrControl(input.stdout),
      isValidSingleJsonValue,
      topLevelJsonType,
      ...(topLevelKeys ? { topLevelKeys } : {}),
      ...(fields ? { fields } : {}),
      multipleJsonValuesDetected,
      ...(jsonlRecordCount !== undefined ? { jsonlRecordCount } : {})
    },
    stderr: {
      byteCount: Buffer.byteLength(input.stderr, "utf8"),
      nonEmptyLineCount: stderrLines.length,
      containsAnsiOrControlChars: containsAnsiOrControl(input.stderr)
    }
  };
}
