import { access, realpath } from "node:fs/promises";
import path from "node:path";
import crossSpawn from "cross-spawn";
import { SAFE_ENVIRONMENT } from "@project-relay/execution";

const ALLOWED_COMMANDS = new Set(["codex", "claude"]);

export type ExecutableFailureCode =
  | "CLI_NOT_FOUND"
  | "CLI_ACCESS_DENIED"
  | "CLI_NOT_EXECUTABLE"
  | "CLI_LAUNCH_FAILED";
export type LauncherType = "native-exe" | "cmd-shim";
export type ResolvedExecutable = {
  command: string;
  canonicalPath: string;
  launcherType?: LauncherType;
};

export class CliExecutableResolutionError extends Error {
  constructor(readonly code: ExecutableFailureCode) {
    super(code);
    this.name = "CliExecutableResolutionError";
  }
}

type LaunchResult = { ok: boolean; failureCode?: ExecutableFailureCode };
type ResolverOptions = {
  platform?: NodeJS.Platform;
  pathValue?: string;
  accessFile?: (path: string) => Promise<void>;
  canonicalize?: (path: string) => Promise<string>;
  launchCandidate?: (candidate: string, launcherType: LauncherType) => Promise<LaunchResult>;
  npmPrefix?: () => Promise<string | undefined>;
};

function launcherTypeFor(candidate: string): LauncherType {
  return candidate.toLowerCase().endsWith(".cmd") ? "cmd-shim" : "native-exe";
}

function failureFrom(error: unknown): ExecutableFailureCode {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (code === "EACCES" || code === "EPERM") return "CLI_ACCESS_DENIED";
  if (code === "ENOENT") return "CLI_NOT_FOUND";
  return "CLI_NOT_EXECUTABLE";
}

async function launchVersion(candidate: string, _launcherType: LauncherType): Promise<LaunchResult> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: LaunchResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    let child;
    try {
      // cross-spawn handles Windows .cmd shims with shell disabled and escaped argument arrays.
      child = crossSpawn(candidate, ["--version"], {
        shell: false,
        windowsHide: true,
        env: SAFE_ENVIRONMENT,
      });
    } catch (error) {
      resolve({ ok: false, failureCode: failureFrom(error) });
      return;
    }

    const timer = setTimeout(() => {
      child.kill();
      settle({ ok: false, failureCode: "CLI_LAUNCH_FAILED" });
    }, 10_000);
    child.once("error", (error) => settle({ ok: false, failureCode: failureFrom(error) }));
    child.once("close", (code) => {
      settle(code === 0 ? { ok: true } : { ok: false, failureCode: "CLI_LAUNCH_FAILED" });
    });
  });
}

async function globalNpmPrefix(): Promise<string | undefined> {
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    const settle = (value: string | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    let child;
    try {
      const npmExecutable = process.platform === "win32"
        ? path.join(path.dirname(process.execPath), "npm.cmd")
        : "npm";
      child = crossSpawn(npmExecutable, ["prefix", "-g"], {
        shell: false,
        windowsHide: true,
        env: SAFE_ENVIRONMENT,
      });
    } catch {
      resolve(undefined);
      return;
    }

    const timer = setTimeout(() => {
      child.kill();
      settle(undefined);
    }, 10_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = `${stdout}${chunk.toString("utf8")}`.slice(0, 4_096);
    });
    child.once("error", () => settle(undefined));
    child.once("close", (code) => settle(code === 0 ? stdout.trim() || undefined : undefined));
  });
}

export function classifyExecutableLaunchError(error: unknown): ExecutableFailureCode {
  return failureFrom(error);
}

export async function resolveCliExecutable(
  command: "codex" | "claude",
  options: ResolverOptions = {},
): Promise<ResolvedExecutable | undefined> {
  if (!ALLOWED_COMMANDS.has(command)) {
    throw new CliExecutableResolutionError("CLI_NOT_FOUND");
  }

  const platform = options.platform ?? process.platform;
  const accessFile = options.accessFile ?? ((candidate) => access(candidate));
  const canonicalize = options.canonicalize ?? realpath;
  const pathValue = options.pathValue ?? process.env.PATH ?? "";
  const extensions = platform === "win32" ? [".exe", ".cmd"] : [""];
  const names = extensions.map((extension) => `${command}${extension}`);
  const pathFolders = pathValue
    .split(path.delimiter)
    .filter(Boolean);
  const npmPrefix = options.npmPrefix
    ? await options.npmPrefix()
    : options.pathValue === undefined
      ? await globalNpmPrefix()
      : undefined;
  const folders = [...pathFolders, ...(npmPrefix && !pathFolders.includes(npmPrefix) ? [npmPrefix] : [])];
  const candidates = folders.flatMap((folder) => names.map((name) => path.join(folder, name)));
  const launchCandidate = options.launchCandidate
    ?? (options.accessFile || options.canonicalize ? undefined : launchVersion);
  let failure: ExecutableFailureCode | undefined;

  for (const candidate of candidates) {
    try {
      await accessFile(candidate);
      const canonicalPath = await canonicalize(candidate);
      const launcherType = launcherTypeFor(canonicalPath);
      if (launchCandidate) {
        const launch = await launchCandidate(canonicalPath, launcherType);
        if (!launch.ok) {
          failure ??= launch.failureCode ?? "CLI_LAUNCH_FAILED";
          continue;
        }
      }
      return { command, canonicalPath, launcherType };
    } catch (error) {
      failure ??= failureFrom(error);
    }
  }

  if (failure && failure !== "CLI_NOT_FOUND") {
    throw new CliExecutableResolutionError(failure);
  }
  return undefined;
}
