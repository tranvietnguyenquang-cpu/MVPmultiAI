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

  /**
   * Default (no explicit model selected) omits -m/--model entirely, letting the CLI's own
   * configured/account default apply. Reasoning effort is passed only through Codex's own
   * documented config-override mechanism (`-c model_reasoning_effort=<value>`), never a
   * bespoke flag - and only when a model was also selected, since effort is meaningless
   * without a specific model. Both session.model and session.reasoningEffort are always
   * the server-resolved registry values, never raw browser strings, and each becomes
   * exactly one argv element - never concatenated into a shell string.
   */
  private modelArgs(session: Pick<AgentSession, "model" | "reasoningEffort">): string[] {
    const args: string[] = [];
    if (session.model) args.push("-m", session.model);
    if (session.model && session.reasoningEffort) args.push("-c", `model_reasoning_effort=${session.reasoningEffort}`);
    return args;
  }

  protected sessionCommand(session: AgentSession, resume: boolean): string[] {
    const sandbox = session.capability === "WORKSPACE_WRITE" ? "workspace-write" : "read-only";
    if (resume && session.externalId) {
      return ["exec", "resume", session.externalId, "--json", "--sandbox", sandbox, ...this.modelArgs(session), "-"];
    }
    return ["exec", "--json", "--sandbox", sandbox, "--skip-git-repo-check", ...this.modelArgs(session), "--cd", session.workspace, "-"];
  }

  protected modelProbeCommand(modelId: string, reasoningEffort?: string) {
    const args = ["exec", "--json", "--sandbox", "read-only", "--skip-git-repo-check", "-m", modelId];
    if (reasoningEffort) args.push("-c", `model_reasoning_effort=${reasoningEffort}`);
    args.push("-");
    return {
      args,
      prompt: "Reply with exactly MODEL_OK. Do not read or modify files.",
      marker: "MODEL_OK",
    };
  }

  protected streamParser() {
    return new CodexStreamParser();
  }
}
