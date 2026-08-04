import type { ClaudeReviewerConfig } from "@project-relay/relay-v2-domain";
import { CLAUDE_VERDICT_JSON_SCHEMA } from "./review-material.js";

/**
 * Builds the exact, fully-verified-flag argv for a read-only Claude review
 * invocation. Every flag here was confirmed present in the local `claude
 * --help` output during Milestone 2.3B discovery (see docs/CLAUDE_REVIEWER.md)
 * -- nothing here is assumed from memory. Review material/evidence never
 * appears in this array; it is rendered to stdin separately by
 * renderClaudePrompt. model/reasoningOrEffort are locked to "AUTO" by the
 * config schema, so no --model/--effort flag is ever pushed (mirrors
 * CodexCliExecutor's own AUTO-omits-the-flag convention).
 */
export function buildClaudeReviewArgv(config: Pick<ClaudeReviewerConfig, "model" | "reasoningOrEffort">): string[] {
  if (config.model !== "AUTO" || config.reasoningOrEffort !== "AUTO") {
    throw new Error("Only AUTO model/reasoning selection is supported by the verified local Claude CLI capability set.");
  }
  return [
    "-p",
    "--output-format", "json",
    "--json-schema", JSON.stringify(CLAUDE_VERDICT_JSON_SCHEMA),
    "--tools", "",
    "--safe-mode",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--disable-slash-commands"
  ];
}
