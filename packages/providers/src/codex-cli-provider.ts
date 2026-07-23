import { CodexStreamParser } from "./protocol/codex-parser.js";
import { CliProvider } from "./process-runner.js";
import type { AgentSession, ExecutionCapability, ProviderRole } from "./types.js";

export class CodexCliProvider extends CliProvider {
  readonly id = "codex-cli" as const;
  readonly name = "Codex CLI";
  readonly command = "codex" as const;
  readonly defaultRoles = ["IMPLEMENTER"] as ProviderRole[];
  readonly setupInstructions = "Install Codex CLI and authenticate with `codex login`. ProjectRelay never reads or stores CLI credentials.";

  protected authCommand() {
    return {
      args: ["exec", "--json", "--sandbox", "read-only", "--skip-git-repo-check", "-"],
      prompt: "Reply with exactly CODEX_OK. Do not read or modify files.",
      marker: "CODEX_OK",
    };
  }

  protected sessionCommand(session: AgentSession, resume: boolean): string[] {
    const sandbox = session.capability === "WORKSPACE_WRITE" ? "workspace-write" : "read-only";
    if (resume && session.externalId) {
      return ["exec", "resume", session.externalId, "--json", "--sandbox", sandbox, "-"];
    }
    return ["exec", "--json", "--sandbox", sandbox, "--skip-git-repo-check", "--cd", session.workspace, "-"];
  }

  protected streamParser() {
    return new CodexStreamParser();
  }
}
