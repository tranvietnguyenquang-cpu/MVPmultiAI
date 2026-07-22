import crossSpawn from "cross-spawn";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import type { CommandSpec } from "@project-relay/shared";

export const SERVER_EXECUTABLE_ALLOWLIST = new Set(["git", "node", "npm", "npx"]);
export const SERVER_COMMAND_CATALOG: Readonly<Record<string,CommandSpec>> = Object.freeze({
  test:{id:"test",label:"Run tests",executable:"npm",args:["test"],category:"safe",evidenceKind:"UNIT_TEST",timeoutMs:600_000},
  typecheck:{id:"typecheck",label:"Type-check",executable:"npm",args:["run","typecheck"],category:"safe",evidenceKind:"TYPECHECK",timeoutMs:600_000},
  lint:{id:"lint",label:"Lint",executable:"npm",args:["run","lint"],category:"safe",evidenceKind:"LINT",timeoutMs:600_000},
  build:{id:"build",label:"Build",executable:"npm",args:["run","build"],category:"safe",evidenceKind:"BUILD",timeoutMs:600_000}
});
export function resolveServerCommands(ids:string[]):CommandSpec[]{return ids.map(id=>{const command=SERVER_COMMAND_CATALOG[id];if(!command)throw new Error(`Unknown server command '${id}'.`);return structuredClone(command);});}
export const SAFE_ENVIRONMENT = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !/(KEY|TOKEN|SECRET|PASSWORD|COOKIE|CREDENTIAL|DATABASE_URL|^GIT_CONFIG_)/i.test(key))
);

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

/** Buffers bounded process output so secrets split across arbitrary stream chunks are redacted together. */
export class StreamSafeRedactor {
  private raw = "";
  constructor(private readonly maxBytes = 65_536) {}
  append(chunk: Buffer | string): void {
    const next = Buffer.from(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    const remaining = Math.max(0, this.maxBytes - Buffer.byteLength(this.raw));
    if (remaining) this.raw += next.subarray(0, remaining).toString("utf8");
  }
  flush(): string { return redactSecrets(this.raw); }
}

export async function validateWorkspace(workspace: string): Promise<string> {
  if (!path.isAbsolute(workspace)) throw new Error("Workspace path must be absolute.");
  const resolved = await realpath(workspace);
  if (!(await stat(resolved)).isDirectory()) throw new Error("Workspace path must be a directory.");
  try { await stat(path.join(resolved, ".git")); } catch { throw new Error("Workspace must be the root of a Git repository."); }
  return resolved;
}

function assertContained(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Path escapes the configured workspace.");
}

export async function resolveInsideWorkspace(workspace: string, candidate: string): Promise<string> {
  const root = await realpath(workspace);
  const lexical = path.resolve(root, candidate);
  assertContained(root, lexical);
  const canonical = await realpath(lexical);
  assertContained(root, canonical);
  return canonical;
}

export function assertAllowedCommand(command: CommandSpec): void {
  if (!SERVER_EXECUTABLE_ALLOWLIST.has(command.executable)) throw new Error(`Executable '${command.executable}' is not server-allowed.`);
}

export type ProcessEvent = { stream: "stdout" | "stderr"; text: string };
export type CommandResult = { startedAt: Date; endedAt: Date; exitCode: number | null; output: string; timedOut: boolean; cancelled: boolean };
type SpawnProcess = typeof crossSpawn;

export async function runCommand(input: {
  workspace: string; command: CommandSpec; signal?: AbortSignal;
  onEvent?: (event: ProcessEvent) => Promise<void> | void; maxOutputBytes?: number; spawnProcess?: SpawnProcess; approved?: boolean;
}): Promise<CommandResult> {
  const workspace = await validateWorkspace(input.workspace);
  assertAllowedCommand(input.command);
  if (input.command.category === "destructive" && !input.approved) throw new Error("Destructive commands require an approved execution record.");
  const startedAt = new Date();
  const stdout = new StreamSafeRedactor(input.maxOutputBytes);
  const stderr = new StreamSafeRedactor(input.maxOutputBytes);
  let timedOut = false;
  let cancelled = false;
  return await new Promise<CommandResult>((resolve, reject) => {
    const spawnProcess = input.spawnProcess ?? crossSpawn;
    const child: ChildProcess = spawnProcess(input.command.executable, input.command.args, { cwd: workspace, env: SAFE_ENVIRONMENT, shell: false, windowsHide: true });
    child.stdout?.on("data", (chunk: Buffer) => stdout.append(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.append(chunk));
    child.once("error", reject);
    const stop = () => { cancelled = true; child.kill(); };
    input.signal?.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, input.command.timeoutMs);
    child.once("close", (exitCode) => {
      clearTimeout(timer); input.signal?.removeEventListener("abort", stop);
      const out = stdout.flush(); const err = stderr.flush();
      if (out) void input.onEvent?.({ stream: "stdout", text: out });
      if (err) void input.onEvent?.({ stream: "stderr", text: err });
      resolve({ startedAt, endedAt: new Date(), exitCode, output: out + err, timedOut, cancelled });
    });
  });
}

const gitCommand = (id: string, args: string[]): CommandSpec => ({ id, label: "Git inspection", executable: "git", args, category: "safe", evidenceKind: "COMMAND", timeoutMs: 30_000 });
export async function inspectGit(workspace: string) {
  const [branch, commit, status, diff, log] = await Promise.all([
    runCommand({ workspace, command: gitCommand("git:branch", ["branch", "--show-current"]) }),
    runCommand({ workspace, command: gitCommand("git:head", ["rev-parse", "HEAD"]) }),
    runCommand({ workspace, command: gitCommand("git:status", ["status", "--short"]) }),
    runCommand({ workspace, command: gitCommand("git:diff", ["diff", "--no-ext-diff", "--binary", "HEAD"]) }),
    runCommand({ workspace, command: gitCommand("git:log", ["log", "-5", "--pretty=format:%h%x09%s%x09%aI"]) })
  ]);
  return { branch: branch.output.trim() || "detached", commit: commit.exitCode === 0 ? commit.output.trim() : null, dirty: status.output.trim().length > 0, status: status.output.trim(), diff: diff.output, recentCommits: log.output.trim().split("\n").filter(Boolean) };
}
