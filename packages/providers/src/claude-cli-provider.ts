import type { TaskCapsuleContent } from "@project-relay/shared";
import { ClaudeStreamParser } from "./protocol/claude-parser.js";
import { CliProvider } from "./process-runner.js";
import type { AgentSession, ExecutionCapability, ProviderRole } from "./types.js";

const CLAUDE_READ_ONLY_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "Bash(git status:*)",
  "Bash(git diff:*)",
  "Bash(npm test:*)",
  "Bash(npm run lint:*)",
  "Bash(npm run typecheck:*)",
  "Bash(npm run build:*)",
];

export class ClaudeCliProvider extends CliProvider {
  readonly id = "claude-cli" as const;
  readonly name = "Claude CLI";
  readonly command = "claude" as const;
  readonly defaultRoles = ["REVIEWER", "VERIFIER"] as ProviderRole[];
  readonly setupInstructions = "Install Claude Code and authenticate with `claude auth login`. ProjectRelay never reads or stores CLI credentials.";

  protected override supportsCapability(capability: ExecutionCapability): boolean {
    return capability === "READ_ONLY";
  }

  protected authCommand() {
    return {
      args: ["-p", "--output-format", "json", "--permission-mode", "dontAsk", "--allowedTools", "Read", "--disallowedTools", "Edit", "Write"],
      prompt: "Reply with exactly CLAUDE_OK. Do not use tools or modify files.",
      marker: "CLAUDE_OK",
    };
  }

  protected override prompt(session: AgentSession, capsule: TaskCapsuleContent): string {
    return [
      `You are a read-only ${session.role}. Never edit, write, install packages, commit, push, reset databases, or run migrations.`,
      super.prompt(session, capsule),
    ].join("\n\n");
  }

  protected sessionCommand(session: AgentSession, resume: boolean): string[] {
    const args = [
      "-p",
      "--verbose",
      "--output-format",
      "stream-json",
      "--permission-mode",
      "dontAsk",
      "--allowedTools",
      ...CLAUDE_READ_ONLY_TOOLS,
      "--disallowedTools",
      "Edit",
      "Write",
      "NotebookEdit",
      "WebFetch",
      "WebSearch",
    ];
    if (resume && session.externalId) {
      args.push("--resume", session.externalId);
    } else {
      args.push("--session-id", session.id);
    }
    return args;
  }

  protected streamParser() {
    return new ClaudeStreamParser();
  }
}
