import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { canonicalJson } from "@project-relay/relay-v2-domain";
import { redactSecrets } from "@project-relay/local-safety";
import { SafeProcessRunner, type ProcessRunner } from "./process-runner.js";

const SENSITIVE_PATH = /(^|\/)(?:\.env(?:\.|$)|credentials?(?:\.|$)|secrets?(?:\.|$)|id_(?:rsa|ed25519)|[^/]+\.(?:pem|key|p12|pfx))$/i;

export type GitStatusEntry = {
  path: string;
  indexStatus: string;
  worktreeStatus: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  sensitive: boolean;
  contentSha256: string | null;
  byteCount: number | null;
  binary: boolean | null;
  indexObjectId?: string | null;
  headObjectId?: string | null;
  worktreeObjectId?: string | null;
};

export type ProtectedPathEvidence = {
  path: string;
  exists: boolean;
  contentSha256: string | null;
  indexObjectId: string | null;
  headObjectId: string | null;
  worktreeObjectId: string | null;
};

export type GitEvidence = {
  repositoryRoot: string;
  branch: string;
  head: string;
  dirty: boolean;
  status: GitStatusEntry[];
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
  patchPreview: string;
  patchSha256: string;
  patchTruncated: boolean;
  patchOmittedForSensitivePaths: boolean;
  stashRef?: string | null;
  stashListHash?: string;
  indexIdentitySha256?: string;
  protectedPaths?: ProtectedPathEvidence[];
  capturedAt: string;
  evidenceHash: string;
};

export type GitEvidenceDelta = {
  baselineHash: string;
  finalHash: string;
  changedFiles: Array<{ path: string; baselineSha256: string | null; finalSha256: string | null; preExisting: boolean; binary: boolean | null }>;
  headChanged: boolean;
  branchChanged: boolean;
  preExistingChangesDestroyed: string[];
  preExistingChangesHidden: string[];
  unaccountedPreExistingPaths: string[];
  stashChanged: boolean;
  forbiddenGitMutationSuspected: boolean;
};

type Capture = { stdout: string; stderr: string; exitCode: number | null; truncated: boolean };

export type WorkspaceEvidenceOptions = {
  runner?: ProcessRunner;
  gitExecutablePath?: string;
  environment?: NodeJS.ProcessEnv;
  maxPatchBytes?: number;
};

export class WorkspaceEvidenceService {
  private readonly runner: ProcessRunner;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly maxPatchBytes: number;

  constructor(private readonly options: WorkspaceEvidenceOptions = {}) {
    this.runner = options.runner ?? new SafeProcessRunner();
    this.environment = options.environment ?? process.env;
    this.maxPatchBytes = options.maxPatchBytes ?? 1024 * 1024;
  }

  async findGitExecutable(): Promise<string | undefined> {
    if (this.options.gitExecutablePath) {
      try { return await realpath(this.options.gitExecutablePath); } catch { return undefined; }
    }
    const names = process.platform === "win32" ? ["git.exe"] : ["git"];
    for (const directory of (this.environment.PATH ?? "").split(path.delimiter).filter(Boolean)) {
      for (const name of names) {
        try { return await realpath(path.join(directory, name)); } catch {}
      }
    }
    const programFiles = this.environment.ProgramFiles ?? this.environment.PROGRAMFILES;
    if (process.platform === "win32" && programFiles) {
      try { return await realpath(path.join(programFiles, "Git", "cmd", "git.exe")); } catch {}
    }
    return undefined;
  }

  private async command(git: string, workspace: string, args: string[], maxOutputBytes = this.maxPatchBytes): Promise<Capture> {
    let stdout = "";
    let stderr = "";
    let exitCode: number | null = null;
    let truncated = false;
    for await (const event of this.runner.run({
      executionId: crypto.randomUUID(), executablePath: git, args, cwd: workspace, timeoutMs: 30_000,
      maxOutputBytes, environment: this.environment
    })) {
      if (event.type === "stdout") stdout += event.message;
      else if (event.type === "stderr") stderr += event.message;
      else if (event.type === "warning") truncated = truncated || /truncat/i.test(event.message);
      else if (event.type === "exit") exitCode = event.result.exitCode;
    }
    return { stdout, stderr, exitCode, truncated };
  }

  private parseStatus(raw: string): Array<Omit<GitStatusEntry, "sensitive" | "contentSha256" | "byteCount" | "binary">> {
    const parts = raw.split("\0").filter(Boolean);
    const entries: Array<Omit<GitStatusEntry, "sensitive" | "contentSha256" | "byteCount" | "binary">> = [];
    for (let index = 0; index < parts.length; index += 1) {
      const item = parts[index]!;
      if (item.length < 3) continue;
      const indexStatus = item[0]!;
      const worktreeStatus = item[1]!;
      const filePath = item.slice(3).replace(/\\/g, "/");
      if (["R", "C"].includes(indexStatus) || ["R", "C"].includes(worktreeStatus)) index += 1;
      entries.push({
        path: filePath,
        indexStatus,
        worktreeStatus,
        staged: indexStatus !== " " && indexStatus !== "?",
        unstaged: worktreeStatus !== " " && worktreeStatus !== "?",
        untracked: indexStatus === "?" && worktreeStatus === "?"
      });
    }
    return entries.sort((left, right) => left.path.localeCompare(right.path));
  }

  private async hashFile(repositoryRoot: string, relativePath: string): Promise<Pick<GitStatusEntry, "contentSha256" | "byteCount" | "binary">> {
    const target = path.resolve(repositoryRoot, relativePath);
    const relative = path.relative(repositoryRoot, target);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return { contentSha256: null, byteCount: null, binary: null };
    try {
      const info = await lstat(target);
      if (!info.isFile()) return { contentSha256: null, byteCount: info.size, binary: null };
      const hash = createHash("sha256");
      let binary = false;
      let sampled = 0;
      await new Promise<void>((resolve, reject) => {
        const stream = createReadStream(target);
        stream.on("data", (value: string | Buffer) => {
          const chunk = typeof value === "string" ? Buffer.from(value) : value;
          hash.update(chunk);
          if (sampled < 8_192) {
            const sample = chunk.subarray(0, 8_192 - sampled);
            if (sample.includes(0)) binary = true;
            sampled += sample.length;
          }
        });
        stream.once("error", reject);
        stream.once("end", resolve);
      });
      return { contentSha256: hash.digest("hex"), byteCount: info.size, binary };
    } catch {
      return { contentSha256: null, byteCount: null, binary: null };
    }
  }

  private parseIndexEntries(raw: string): Map<string, string> {
    const result = new Map<string, string>();
    for (const entry of raw.split("\0").filter(Boolean)) {
      const match = /^(?:\d+)\s+([a-f0-9]+)\s+\d+\t(.+)$/i.exec(entry);
      if (match?.[1] && match[2]) result.set(match[2].replace(/\\/g, "/"), match[1]);
    }
    return result;
  }

  private async objectId(git: string, repositoryRoot: string, args: string[]): Promise<string | null> {
    const result = await this.command(git, repositoryRoot, args, 16 * 1024);
    const value = result.stdout.trim();
    return result.exitCode === 0 && /^[a-f0-9]{40,64}$/i.test(value) ? value : null;
  }

  async capture(workspace: string, protectedPaths: readonly string[] = []): Promise<GitEvidence> {
    const git = await this.findGitExecutable();
    if (!git) throw new Error("Git executable was not found.");
    const root = await this.command(git, workspace, ["rev-parse", "--show-toplevel"]);
    if (root.exitCode !== 0) throw new Error(redactSecrets(root.stderr || "Workspace is not a Git repository."));
    const repositoryRoot = await realpath(root.stdout.trim());
    const [branchResult, headResult, statusResult, indexResult, stashRefResult, stashListResult] = await Promise.all([
      this.command(git, repositoryRoot, ["branch", "--show-current"]),
      this.command(git, repositoryRoot, ["rev-parse", "HEAD"]),
      this.command(git, repositoryRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
      this.command(git, repositoryRoot, ["ls-files", "--stage", "-z"]),
      this.command(git, repositoryRoot, ["rev-parse", "--verify", "refs/stash"]),
      this.command(git, repositoryRoot, ["stash", "list", "--format=%H%x00%gd%x00%gs"])
    ]);
    if (branchResult.exitCode !== 0 || headResult.exitCode !== 0 || statusResult.exitCode !== 0 || indexResult.exitCode !== 0 || stashListResult.exitCode !== 0) throw new Error("Git baseline inspection failed.");
    const indexEntries = this.parseIndexEntries(indexResult.stdout);
    const parsed = this.parseStatus(statusResult.stdout);
    const status: GitStatusEntry[] = [];
    for (const item of parsed) {
      const fileEvidence = await this.hashFile(repositoryRoot, item.path);
      status.push({
        ...item, sensitive: SENSITIVE_PATH.test(item.path), ...fileEvidence,
        indexObjectId: indexEntries.get(item.path) ?? null,
        headObjectId: await this.objectId(git, repositoryRoot, ["rev-parse", `HEAD:${item.path}`]),
        worktreeObjectId: fileEvidence.contentSha256 ? await this.objectId(git, repositoryRoot, ["hash-object", "--no-filters", "--", item.path]) : null
      });
    }
    const protectedPathNames = [...new Set([...status.map(item => item.path), ...protectedPaths.map(item => item.replace(/\\/g, "/"))])].sort();
    const protectedPathEvidence: ProtectedPathEvidence[] = [];
    for (const filePath of protectedPathNames) {
      const fileEvidence = await this.hashFile(repositoryRoot, filePath);
      protectedPathEvidence.push({
        path: filePath, exists: fileEvidence.contentSha256 !== null, contentSha256: fileEvidence.contentSha256,
        indexObjectId: indexEntries.get(filePath) ?? null,
        headObjectId: await this.objectId(git, repositoryRoot, ["rev-parse", `HEAD:${filePath}`]),
        worktreeObjectId: fileEvidence.contentSha256 ? await this.objectId(git, repositoryRoot, ["hash-object", "--no-filters", "--", filePath]) : null
      });
    }
    const patchOmittedForSensitivePaths = status.some(item => item.sensitive);
    let patchPreview = "";
    let patchTruncated = false;
    if (!patchOmittedForSensitivePaths) {
      const [staged, unstaged] = await Promise.all([
        this.command(git, repositoryRoot, ["diff", "--cached", "--binary", "--no-ext-diff"], this.maxPatchBytes),
        this.command(git, repositoryRoot, ["diff", "--binary", "--no-ext-diff"], this.maxPatchBytes)
      ]);
      patchPreview = redactSecrets(`--- STAGED ---\n${staged.stdout}\n--- UNSTAGED ---\n${unstaged.stdout}`);
      patchTruncated = staged.truncated || unstaged.truncated || Buffer.byteLength(patchPreview, "utf8") > this.maxPatchBytes;
      if (Buffer.byteLength(patchPreview, "utf8") > this.maxPatchBytes) patchPreview = Buffer.from(patchPreview).subarray(0, this.maxPatchBytes).toString("utf8");
    }
    const evidenceForHash = {
      repositoryRoot, branch: branchResult.stdout.trim() || "DETACHED", head: headResult.stdout.trim(), dirty: status.length > 0,
      status, stagedCount: status.filter(item => item.staged).length, unstagedCount: status.filter(item => item.unstaged).length,
      untrackedCount: status.filter(item => item.untracked).length, patchPreview,
      patchSha256: createHash("sha256").update(patchPreview).digest("hex"), patchTruncated, patchOmittedForSensitivePaths
      , stashRef: stashRefResult.exitCode === 0 ? stashRefResult.stdout.trim() : null,
      stashListHash: createHash("sha256").update(stashListResult.stdout).digest("hex"),
      indexIdentitySha256: createHash("sha256").update(indexResult.stdout).digest("hex"),
      protectedPaths: protectedPathEvidence
    };
    return {
      ...evidenceForHash, capturedAt: new Date().toISOString(),
      evidenceHash: createHash("sha256").update(canonicalJson(evidenceForHash)).digest("hex")
    };
  }
}

export function compareGitEvidence(baseline: GitEvidence, final: GitEvidence): GitEvidenceDelta {
  const before = new Map(baseline.status.map(item => [item.path, item]));
  const after = new Map(final.status.map(item => [item.path, item]));
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort((left, right) => left.localeCompare(right));
  const changedFiles = paths.filter(file => {
    const left = before.get(file);
    const right = after.get(file);
    return canonicalJson(left ?? null) !== canonicalJson(right ?? null);
  }).map(file => ({
    path: file,
    baselineSha256: before.get(file)?.contentSha256 ?? null,
    finalSha256: after.get(file)?.contentSha256 ?? null,
    preExisting: before.has(file),
    binary: after.get(file)?.binary ?? before.get(file)?.binary ?? null
  }));
  const finalProtected = new Map((final.protectedPaths ?? []).map(item => [item.path, item]));
  const preExistingChangesDestroyed = new Set<string>();
  const preExistingChangesHidden = new Set<string>();
  const unaccountedPreExistingPaths = new Set<string>();
  for (const item of baseline.status) {
    const finalStatus = after.get(item.path);
    const protectedFinal = finalProtected.get(item.path);
    if (!protectedFinal) {
      unaccountedPreExistingPaths.add(item.path);
      continue;
    }
    if (item.untracked && !protectedFinal.exists) preExistingChangesDestroyed.add(item.path);
    if (item.staged && (!finalStatus?.staged || item.indexObjectId !== protectedFinal.indexObjectId)) preExistingChangesHidden.add(item.path);
    if (item.unstaged) {
      if (!protectedFinal.exists || !finalStatus || (item.headObjectId && protectedFinal.worktreeObjectId === item.headObjectId)) {
        preExistingChangesDestroyed.add(item.path);
      } else if (!finalStatus?.unstaged && item.contentSha256 === protectedFinal.contentSha256) {
        preExistingChangesHidden.add(item.path);
      }
    }
  }
  const headChanged = baseline.head !== final.head;
  const branchChanged = baseline.branch !== final.branch;
  const stashChanged = baseline.stashRef !== final.stashRef || baseline.stashListHash !== final.stashListHash;
  const destroyed = [...preExistingChangesDestroyed].sort();
  const hidden = [...preExistingChangesHidden].sort();
  const unaccounted = [...unaccountedPreExistingPaths].sort();
  return {
    baselineHash: baseline.evidenceHash, finalHash: final.evidenceHash, changedFiles, headChanged, branchChanged,
    preExistingChangesDestroyed: destroyed, preExistingChangesHidden: hidden,
    unaccountedPreExistingPaths: unaccounted, stashChanged,
    forbiddenGitMutationSuspected: headChanged || branchChanged || stashChanged || destroyed.length > 0 || hidden.length > 0 || unaccounted.length > 0
  };
}
