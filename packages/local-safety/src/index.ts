import { realpath, stat } from "node:fs/promises";
import path from "node:path";

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
  try {
    await stat(path.join(resolved, ".git"));
  } catch {
    throw new Error("Workspace must be the root of a Git repository.");
  }
  return resolved;
}
