import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { CommandSpec } from "@project-relay/shared";

const SECRET_PATTERNS = [
  /\b(?:sk|pk)-[a-zA-Z0-9_-]{16,}\b/g,
  /\b(?:ghp|github_pat)_[a-zA-Z0-9_]{16,}\b/g,
  /\bBearer\s+[a-zA-Z0-9._~+/-]+=*\b/gi,
  /(?:password|passwd|token|api[_-]?key|secret|cookie)\s*[=:]\s*[^\s,;]+/gi,
  /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s]+/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g
];

export function redactSecrets(input: string): string {
  return SECRET_PATTERNS.reduce((text, pattern) => text.replace(pattern, "[REDACTED]"), input);
}

export async function validateWorkspace(workspace: string): Promise<string> {
  if (!path.isAbsolute(workspace)) throw new Error("Workspace path must be absolute.");
  const resolved = await realpath(workspace);
  if (!(await stat(resolved)).isDirectory()) throw new Error("Workspace path must be a directory.");
  const gitPath = path.join(resolved, ".git");
  try { await stat(gitPath); } catch { throw new Error("Workspace must be the root of a Git repository."); }
  return resolved;
}

export async function resolveInsideWorkspace(workspace: string, candidate: string): Promise<string> {
  const root = await realpath(workspace);
  const resolved = path.resolve(root, candidate);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Path escapes the configured workspace.");
  return resolved;
}

export type ProcessEvent = { stream: "stdout" | "stderr"; text: string };
export type CommandResult = { startedAt: Date; endedAt: Date; exitCode: number | null; output: string; timedOut: boolean; cancelled: boolean };

export async function runCommand(input: {
  workspace: string;
  command: CommandSpec;
  signal?: AbortSignal;
  onEvent?: (event: ProcessEvent) => Promise<void> | void;
  maxOutputBytes?: number;
}): Promise<CommandResult> {
  const workspace = await validateWorkspace(input.workspace);
  if (input.command.category === "destructive") throw new Error("Destructive commands require an approved execution record.");
  const startedAt = new Date();
  const maxBytes = input.maxOutputBytes ?? 65_536;
  let output = "";
  let timedOut = false;
  let cancelled = false;
  const safeEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(KEY|TOKEN|SECRET|PASSWORD|COOKIE|CREDENTIAL|DATABASE_URL)/i.test(key)));

  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(input.command.executable, input.command.args, { cwd: workspace, env: safeEnv, shell: false, windowsHide: true });
    const append = (stream: "stdout" | "stderr", chunk: Buffer) => {
      const text = redactSecrets(chunk.toString("utf8"));
      if (Buffer.byteLength(output) < maxBytes) output += text.slice(0, maxBytes - Buffer.byteLength(output));
      void input.onEvent?.({ stream, text });
    };
    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.once("error", reject);
    const stop = () => { cancelled = true; child.kill(); };
    input.signal?.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, input.command.timeoutMs);
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", stop);
      resolve({ startedAt, endedAt: new Date(), exitCode, output, timedOut, cancelled });
    });
  });
}

const gitCommand = (args: string[]): CommandSpec => ({ id: "git:inspect", label: "Git inspection", executable: "git", args, category: "safe", evidenceKind: "COMMAND", timeoutMs: 30_000 });

export async function inspectGit(workspace: string) {
  const [branch, commit, status, log] = await Promise.all([
    runCommand({ workspace, command: gitCommand(["branch", "--show-current"]) }),
    runCommand({ workspace, command: gitCommand(["rev-parse", "HEAD"]) }),
    runCommand({ workspace, command: gitCommand(["status", "--short"]) }),
    runCommand({ workspace, command: gitCommand(["log", "-5", "--pretty=format:%h%x09%s%x09%aI"]) })
  ]);
  return { branch: branch.output.trim() || "detached", commit: commit.exitCode === 0 ? commit.output.trim() : null, dirty: status.output.trim().length > 0, status: status.output.trim(), recentCommits: log.output.trim().split("\n").filter(Boolean) };
}
