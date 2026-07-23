export type UsageReport = { estimated: boolean; inputTokens?: number; outputTokens?: number; costUsd?: number };

/**
 * Normalized events extracted from a provider's structured JSON/JSONL stdout stream.
 * Parsers never throw on malformed input; unparseable or unrecognized lines become
 * "diagnostic" events so a single bad line cannot take down the whole run.
 */
export type ParsedStreamEvent =
  | { kind: "assistant"; text: string }
  | { kind: "assistant-final"; text: string }
  | { kind: "session"; externalSessionId: string }
  | { kind: "usage"; usage: UsageReport }
  | { kind: "terminal"; status: "SUCCEEDED" | "FAILED"; reason?: string }
  | { kind: "diagnostic"; message: string };

export interface StructuredStreamParser {
  parseLine(line: string): ParsedStreamEvent[];
}

/** Bounds a single buffered (not-yet-newline-terminated) line so a runaway stream cannot grow memory unbounded. */
const MAX_LINE_BYTES = 65_536;

/**
 * Splits an arbitrary sequence of raw chunks into complete lines, buffering partial
 * lines across chunk boundaries (including a boundary that falls mid-line or mid-token).
 */
export type ReaderLine = { text: string; truncated: boolean };

export class IncrementalLineReader {
  private buffer = "";

  push(chunk: string): ReaderLine[] {
    this.buffer += chunk;
    const lines: ReaderLine[] = [];
    let index: number;
    while ((index = this.buffer.indexOf("\n")) !== -1) {
      lines.push({ text: this.buffer.slice(0, index), truncated: false });
      this.buffer = this.buffer.slice(index + 1);
    }
    if (this.buffer.length > MAX_LINE_BYTES) {
      lines.push({ text: this.buffer.slice(0, MAX_LINE_BYTES), truncated: true });
      this.buffer = "";
    }
    return lines;
  }

  /** Call once at stream end to flush a trailing line that never received its newline. */
  end(): ReaderLine[] {
    if (!this.buffer) return [];
    const remainder = this.buffer;
    this.buffer = "";
    return [{ text: remainder, truncated: false }];
  }
}

function safeJson(line: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(line) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function str(record: Record<string, unknown>, key: string): string | undefined {
  return typeof record[key] === "string" ? (record[key] as string) : undefined;
}

function num(record: Record<string, unknown>, key: string): number | undefined {
  return typeof record[key] === "number" ? (record[key] as number) : undefined;
}

/**
 * Codex CLI `exec --json` JSONL protocol: one JSON object per line, shaped as
 * `{"type": "...", ...}`. Recognized event types:
 *  - session_configured { session_id }   -> authoritative external session id
 *  - agent_message { message }          -> assistant answer text (may repeat; appended)
 *  - token_count { input_tokens, output_tokens } -> usage
 *  - error { message }                  -> terminal failure with a sanitized reason
 *  - task_complete                      -> terminal success
 * Anything else becomes a diagnostic event, never the assistant answer.
 */
export class CodexStreamParser implements StructuredStreamParser {
  parseLine(line: string): ParsedStreamEvent[] {
    const trimmed = line.trim();
    if (!trimmed) return [];
    const record = safeJson(trimmed);
    if (!record) return [{ kind: "diagnostic", message: `Unparseable Codex output line ignored (${trimmed.length} bytes).` }];

    const type = str(record, "type");
    switch (type) {
      case "session_configured": {
        const sessionId = str(record, "session_id");
        return sessionId ? [{ kind: "session", externalSessionId: sessionId }] : [];
      }
      case "agent_message": {
        const message = str(record, "message") ?? "";
        return message ? [{ kind: "assistant", text: message }] : [];
      }
      case "token_count": {
        const inputTokens = num(record, "input_tokens");
        const outputTokens = num(record, "output_tokens");
        return [{ kind: "usage", usage: { estimated: false, ...(inputTokens !== undefined ? { inputTokens } : {}), ...(outputTokens !== undefined ? { outputTokens } : {}) } }];
      }
      case "error": {
        const message = str(record, "message") ?? "Codex reported an error.";
        return [{ kind: "terminal", status: "FAILED", reason: message }];
      }
      case "task_complete":
        return [{ kind: "terminal", status: "SUCCEEDED" }];
      default:
        return [{ kind: "diagnostic", message: `Codex event: ${type ?? "unknown"}.` }];
    }
  }
}

type ClaudeContentBlock = { type?: string; text?: string };

/**
 * Claude Code CLI `--output-format stream-json` protocol: one JSON object per line.
 * Recognized event types:
 *  - system { subtype: "init", session_id } -> authoritative external session id
 *  - assistant { message: { content: [...] } } -> streamed assistant text blocks (appended)
 *  - result { subtype, is_error, result, usage, session_id } -> terminal status + usage;
 *    `result` is the CLI's own authoritative final answer and replaces any accumulated
 *    partial assistant text rather than appending to it.
 */
export class ClaudeStreamParser implements StructuredStreamParser {
  parseLine(line: string): ParsedStreamEvent[] {
    const trimmed = line.trim();
    if (!trimmed) return [];
    const record = safeJson(trimmed);
    if (!record) return [{ kind: "diagnostic", message: `Unparseable Claude output line ignored (${trimmed.length} bytes).` }];

    const events: ParsedStreamEvent[] = [];
    const sessionId = str(record, "session_id");
    if (sessionId) events.push({ kind: "session", externalSessionId: sessionId });

    const type = str(record, "type");
    switch (type) {
      case "system":
        return events;
      case "assistant": {
        // Intermediate assistant message blocks are progress/state, not the final answer:
        // Claude's terminal "result" event carries the authoritative complete text (below).
        // Surfacing these as diagnostics (rather than "assistant" text to append) avoids
        // duplicating content once the final result supersedes it.
        const message = record.message as { content?: ClaudeContentBlock[] } | undefined;
        const text = (message?.content ?? [])
          .filter((block): block is ClaudeContentBlock & { text: string } => block?.type === "text" && typeof block.text === "string")
          .map(block => block.text)
          .join("");
        if (text) events.push({ kind: "diagnostic", message: `Claude (in progress): ${text.slice(0, 200)}` });
        return events;
      }
      case "result": {
        const isError = record.is_error === true;
        const usage = record.usage as { input_tokens?: number; output_tokens?: number } | undefined;
        if (usage) {
          const inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : undefined;
          const outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : undefined;
          events.push({ kind: "usage", usage: { estimated: false, ...(inputTokens !== undefined ? { inputTokens } : {}), ...(outputTokens !== undefined ? { outputTokens } : {}) } });
        }
        const resultText = str(record, "result");
        if (!isError && resultText) events.push({ kind: "assistant-final", text: resultText });
        events.push({ kind: "terminal", status: isError ? "FAILED" : "SUCCEEDED", ...(isError ? { reason: resultText ?? "Claude reported an error." } : {}) });
        return events;
      }
      default:
        events.push({ kind: "diagnostic", message: `Claude event: ${type ?? "unknown"}.` });
        return events;
    }
  }
}

export type StreamOutcome = {
  assistantText: string;
  usage: UsageReport;
  externalSessionId?: string;
  terminal?: { status: "SUCCEEDED" | "FAILED"; reason?: string };
  diagnostics: string[];
};

/** Feeds parsed lines into a running, queryable snapshot of the structured stream. */
export class StructuredStreamAccumulator {
  private assistantText = "";
  private usage: UsageReport = { estimated: true };
  private externalSessionId: string | undefined;
  private terminal: { status: "SUCCEEDED" | "FAILED"; reason?: string } | undefined;
  private readonly diagnostics: string[] = [];

  constructor(private readonly parser: StructuredStreamParser) {}

  consumeLine(line: string): ParsedStreamEvent[] {
    let events: ParsedStreamEvent[];
    try {
      events = this.parser.parseLine(line);
    } catch {
      events = [{ kind: "diagnostic", message: "Provider stream line raised a parser error and was ignored." }];
    }
    for (const evt of events) this.apply(evt);
    return events;
  }

  /** Handles a line from IncrementalLineReader, surfacing a dedicated output-limit diagnostic for a truncated line instead of attempting to parse guaranteed-incomplete content. */
  consumeReaderLine(line: ReaderLine): ParsedStreamEvent[] {
    if (line.truncated) {
      const event: ParsedStreamEvent = { kind: "diagnostic", message: `Provider output line truncated after exceeding ${MAX_LINE_BYTES} bytes without a newline; the line was discarded.` };
      this.apply(event);
      return [event];
    }
    return this.consumeLine(line.text);
  }

  private apply(evt: ParsedStreamEvent): void {
    switch (evt.kind) {
      case "assistant":
        this.assistantText += evt.text;
        break;
      case "assistant-final":
        this.assistantText = evt.text;
        break;
      case "session":
        this.externalSessionId = evt.externalSessionId;
        break;
      case "usage":
        this.usage = evt.usage;
        break;
      case "terminal":
        this.terminal = { status: evt.status, ...(evt.reason ? { reason: evt.reason } : {}) };
        break;
      case "diagnostic":
        this.diagnostics.push(evt.message);
        break;
    }
  }

  snapshot(): StreamOutcome {
    return {
      assistantText: this.assistantText,
      usage: this.usage,
      ...(this.externalSessionId ? { externalSessionId: this.externalSessionId } : {}),
      ...(this.terminal ? { terminal: this.terminal } : {}),
      diagnostics: [...this.diagnostics]
    };
  }
}

/** Thrown when a resumed session's external id is no longer recognized by the CLI. */
export class StaleProviderSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleProviderSessionError";
  }
}

const STALE_SESSION_PATTERN = /no (conversation|session|thread) found|session (not found|expired|invalid|does not exist)|unknown session|resume target unavailable/i;

export function isStaleProviderSessionSignal(...texts: Array<string | undefined>): boolean {
  return texts.some(text => text && STALE_SESSION_PATTERN.test(text));
}
