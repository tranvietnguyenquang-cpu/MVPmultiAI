import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CodexCapabilitySnapshot } from "./codex-capabilities.js";
import { SafeProcessRunner, type ProcessRunner } from "./process-runner.js";
import { WorkspaceEvidenceService } from "./workspace-evidence.js";

type CommandResult = { exitCode: number | null; stdout: string; stderr: string };

export type DisposableGitWorkspace = {
  workspacePath: string;
  cleanup(): Promise<void>;
};

export type DisposableWorkspaceOptions = {
  runner?: ProcessRunner;
  gitExecutablePath?: string;
  environment?: NodeJS.ProcessEnv;
  temporaryRoot?: string;
};

async function command(
  runner: ProcessRunner,
  executablePath: string,
  cwd: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv
): Promise<CommandResult> {
  let stdout = "";
  let stderr = "";
  let exitCode: number | null = null;
  for await (const event of runner.run({
    executionId: crypto.randomUUID(), executablePath, args, cwd, environment,
    timeoutMs: 30_000, maxOutputBytes: 512 * 1024
  })) {
    if (event.type === "stdout") stdout += event.message;
    if (event.type === "stderr" || event.type === "warning") stderr += event.message;
    if (event.type === "exit") exitCode = event.result.exitCode;
  }
  return { exitCode, stdout, stderr };
}

function assertOutsideRelay(workspacePath: string): void {
  const relative = path.relative(path.resolve(process.cwd()), workspacePath);
  if (!relative || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    throw new Error("Disposable Codex smoke workspace must be outside the Relay repository.");
  }
}

export async function prepareDisposableGitWorkspace(options: DisposableWorkspaceOptions = {}): Promise<DisposableGitWorkspace> {
  const runner = options.runner ?? new SafeProcessRunner();
  const environment = options.environment ?? process.env;
  const temporaryRoot = await realpath(options.temporaryRoot ?? tmpdir());
  assertOutsideRelay(temporaryRoot);
  const workspace = await mkdtemp(path.join(temporaryRoot, "relay-v2-real-codex-smoke-"));
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  };
  try {
    const evidence = new WorkspaceEvidenceService({
      runner, environment,
      ...(options.gitExecutablePath ? { gitExecutablePath: options.gitExecutablePath } : {})
    });
    const git = await evidence.findGitExecutable();
    if (!git) throw new Error("Git executable was not found for the disposable Codex smoke workspace.");
    const required = async (args: readonly string[]): Promise<string> => {
      const result = await command(runner, git, workspace, args, environment);
      if (result.exitCode !== 0) throw new Error(`Disposable Git workspace preparation failed for '${args[0] ?? "git"}' (exit ${result.exitCode ?? "unknown"}): ${result.stderr.trim().slice(0, 500)}`);
      return result.stdout.trim();
    };
    await required(["init"]);
    await required(["config", "--local", "user.name", "Relay Disposable Smoke"]);
    await required(["config", "--local", "user.email", "relay-smoke@invalid.local"]);
    await writeFile(path.join(workspace, "README.md"), "Disposable Relay v2 Codex read-only smoke workspace.\n", { encoding: "utf8", flag: "wx" });
    await required(["add", "--", "README.md"]);
    await required(["commit", "-m", "Create disposable smoke baseline"]);
    const canonicalWorkspace = await realpath(workspace);
    const root = await realpath(await required(["rev-parse", "--show-toplevel"]));
    if (root !== canonicalWorkspace) throw new Error("Disposable Git root does not match the prepared workspace.");
    const head = await required(["rev-parse", "HEAD"]);
    if (!/^[a-f0-9]{40,64}$/i.test(head)) throw new Error("Disposable Git baseline commit could not be verified.");
    if ((await required(["status", "--porcelain=v1", "--untracked-files=all"])) !== "") throw new Error("Disposable Git baseline is not clean.");
    return { workspacePath: canonicalWorkspace, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export type RealCodexSmokeResult = {
  status: "PASSED" | "SKIPPED";
  reason?: string;
  exitCode?: number | null;
};

export async function runDisposableReadOnlyCodexSmoke(
  snapshot: CodexCapabilitySnapshot,
  options: DisposableWorkspaceOptions & { codexRunner?: ProcessRunner; prepareWorkspace?: typeof prepareDisposableGitWorkspace } = {}
): Promise<RealCodexSmokeResult> {
  if (!snapshot.executablePath || !snapshot.supported || snapshot.authenticationStatus === "UNAVAILABLE") {
    return { status: "SKIPPED", reason: snapshot.unsupportedReasons.join(" ") || "Codex CLI is unavailable." };
  }
  const prepared = await (options.prepareWorkspace ?? prepareDisposableGitWorkspace)(options);
  try {
    const runner = options.codexRunner ?? new SafeProcessRunner();
    let exitCode: number | null = null;
    let output = "";
    for await (const event of runner.run({
      executionId: crypto.randomUUID(), executablePath: snapshot.executablePath,
      args: ["-a", "never", "exec", "--ephemeral", "--ignore-user-config", "--color", "never", "--json", "-s", "read-only", "-C", prepared.workspacePath, "-"],
      cwd: prepared.workspacePath,
      stdin: "Read README.md only. Do not modify any file. Reply with a one-sentence summary.",
      timeoutMs: 120_000, maxOutputBytes: 5 * 1024 * 1024
    })) {
      if (event.type === "stdout" || event.type === "stderr" || event.type === "warning") output += event.message;
      if (event.type === "exit") exitCode = event.result.exitCode;
    }
    if (exitCode === 0) return { status: "PASSED", exitCode };
    if (/not logged in|authentication required|please log in|login required/i.test(output)) {
      return { status: "SKIPPED", exitCode, reason: `Codex subscription authentication is unavailable (exit ${exitCode ?? "unknown"}).` };
    }
    throw new Error(`Codex read-only smoke exited ${exitCode ?? "without an exit code"}: ${output.trim().slice(0, 2_000)}`);
  } finally {
    await prepared.cleanup();
  }
}
