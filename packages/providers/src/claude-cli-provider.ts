import { SERVER_COMMAND_CATALOG } from "@project-relay/execution";
import type { TaskCapsuleContent } from "@project-relay/shared";
import { ClaudeStreamParser } from "./protocol/claude-parser.js";
import { CliProvider } from "./process-runner.js";
import type { AgentSession, ExecutionCapability, ProviderRole } from "./types.js";

/**
 * The only Bash invocations ever granted to Claude: the exact same server-owned
 * command catalog the rest of the system uses for evidence capture (see
 * SERVER_COMMAND_CATALOG in @project-relay/execution), plus two read-only Git
 * inspection commands. This is a fixed allowlist derived entirely from server-side
 * definitions - it never accepts an executable, argument, or flag supplied by a
 * browser request or a provider prompt, and it is identical for read-only and
 * workspace-write sessions: workspace-write only ever adds the Edit/Write file
 * tools, never a wider Bash surface. There is deliberately no allowlisted pattern
 * for package installation, `git commit`, `git push`, or any database operation,
 * so those remain unreachable regardless of what the model attempts.
 */
const CLAUDE_APPROVED_BASH_TOOLS = [
  "Bash(git status:*)",
  "Bash(git diff:*)",
  ...Object.values(SERVER_COMMAND_CATALOG).map(command => `Bash(${command.executable} ${command.args.join(" ")}:*)`),
];

const CLAUDE_READ_ONLY_TOOLS = ["Read", "Glob", "Grep", ...CLAUDE_APPROVED_BASH_TOOLS];
const CLAUDE_IMPLEMENT_TOOLS = ["Read", "Glob", "Grep", "Edit", "Write", ...CLAUDE_APPROVED_BASH_TOOLS];

// Always denied regardless of capability: never part of any server-approved command,
// and NotebookEdit/WebFetch/WebSearch have no place in a local-only, workspace-scoped run.
const CLAUDE_ALWAYS_DISALLOWED_TOOLS = ["NotebookEdit", "WebFetch", "WebSearch"];

export class ClaudeCliProvider extends CliProvider {
  readonly id = "claude-cli" as const;
  readonly name = "Claude CLI";
  readonly command = "claude" as const;
  readonly defaultRoles = ["REVIEWER", "VERIFIER"] as ProviderRole[];
  readonly setupInstructions = "Install Claude Code and authenticate with `claude auth login`. ProjectRelay never reads or stores CLI credentials.";

  protected override supportsCapability(capability: ExecutionCapability): boolean {
    return capability === "READ_ONLY" || capability === "WORKSPACE_WRITE";
  }

  protected authCommand() {
    return {
      args: ["-p", "--output-format", "json", "--permission-mode", "dontAsk", "--allowedTools", "Read", "--disallowedTools", "Edit", "Write"],
      prompt: "Reply with exactly CLAUDE_OK. Do not use tools or modify files.",
      marker: "CLAUDE_OK",
    };
  }

  protected override prompt(session: AgentSession, capsule: TaskCapsuleContent): string {
    const rules = session.capability === "WORKSPACE_WRITE"
      ? `You are an IMPLEMENTER with workspace-write access limited to the registered repository at ${session.workspace}. You may read, edit, and write files inside this workspace, and you may run only the pre-approved test/typecheck/lint/build/git-status/git-diff commands made available to you as tools. Never access or write files outside this workspace, install packages, run \`git commit\`, run \`git push\`, or perform any destructive database operation - those are not available to you and any attempt will be refused.`
      : `You are a read-only ${session.role}. Never edit, write, install packages, commit, push, reset databases, or run migrations.`;
    return [rules, super.prompt(session, capsule)].join("\n\n");
  }

  protected sessionCommand(session: AgentSession, resume: boolean): string[] {
    const allowedTools = session.capability === "WORKSPACE_WRITE" ? CLAUDE_IMPLEMENT_TOOLS : CLAUDE_READ_ONLY_TOOLS;
    const disallowedTools = session.capability === "WORKSPACE_WRITE"
      ? [...CLAUDE_ALWAYS_DISALLOWED_TOOLS]
      : ["Edit", "Write", ...CLAUDE_ALWAYS_DISALLOWED_TOOLS];
    const args = [
      "-p",
      "--verbose",
      "--output-format",
      "stream-json",
      "--permission-mode",
      "dontAsk",
      "--allowedTools",
      ...allowedTools,
      "--disallowedTools",
      ...disallowedTools,
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
