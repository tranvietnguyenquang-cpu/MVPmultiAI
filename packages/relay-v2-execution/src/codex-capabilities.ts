import { createHash, randomUUID } from "node:crypto";
import { access, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { SafeProcessRunner, type ProcessRunner } from "./process-runner.js";

export const codexCapabilitySnapshotSchema = z.object({
  executorId: z.literal("codex-cli"),
  executablePath: z.string(),
  displayPath: z.string(),
  version: z.string(),
  detectedAt: z.string().datetime(),
  execAvailable: z.boolean(),
  modelFlag: z.boolean(),
  reasoningEffortMechanism: z.enum(["UNKNOWN", "UNSUPPORTED", "CONFIG_OVERRIDE"]),
  sandboxModes: z.array(z.enum(["read-only", "workspace-write", "danger-full-access"])),
  approvalModes: z.array(z.enum(["untrusted", "on-request", "never"])),
  outputModes: z.array(z.enum(["jsonl", "output-schema", "last-message"])),
  workingDirectorySupport: z.boolean(),
  timeoutManagedByRelay: z.literal(true),
  cancellationManagedByRelay: z.literal(true),
  authenticationStatus: z.enum(["AUTHENTICATED", "UNAUTHENTICATED", "UNKNOWN", "UNAVAILABLE"]),
  rawHelpHash: z.string().regex(/^[a-f0-9]{64}$/),
  supported: z.boolean(),
  unsupportedReasons: z.array(z.string())
}).strict();
export type CodexCapabilitySnapshot = z.infer<typeof codexCapabilitySnapshotSchema>;

export const codexDiagnosticsDtoSchema = codexCapabilitySnapshotSchema.omit({ executablePath: true }).extend({
  authenticationEvidence: z.literal("CODEX_LOGIN_STATUS"),
  realExecutionReadiness: z.literal("NOT_PROVEN")
}).strict();
export type CodexDiagnosticsDto = z.infer<typeof codexDiagnosticsDtoSchema>;

export function toCodexDiagnosticsDto(snapshot: CodexCapabilitySnapshot): CodexDiagnosticsDto {
  return codexDiagnosticsDtoSchema.parse({
    executorId: snapshot.executorId,
    displayPath: snapshot.displayPath,
    version: snapshot.version,
    detectedAt: snapshot.detectedAt,
    execAvailable: snapshot.execAvailable,
    modelFlag: snapshot.modelFlag,
    reasoningEffortMechanism: snapshot.reasoningEffortMechanism,
    sandboxModes: snapshot.sandboxModes,
    approvalModes: snapshot.approvalModes,
    outputModes: snapshot.outputModes,
    workingDirectorySupport: snapshot.workingDirectorySupport,
    timeoutManagedByRelay: snapshot.timeoutManagedByRelay,
    cancellationManagedByRelay: snapshot.cancellationManagedByRelay,
    authenticationStatus: snapshot.authenticationStatus,
    rawHelpHash: snapshot.rawHelpHash,
    supported: snapshot.supported,
    unsupportedReasons: snapshot.unsupportedReasons,
    authenticationEvidence: "CODEX_LOGIN_STATUS",
    realExecutionReadiness: "NOT_PROVEN"
  });
}

type CommandCapture = { stdout: string; stderr: string; exitCode: number | null };

function hasOption(help: string, option: string): boolean {
  return help.includes(option);
}

export function parseCodexCapabilityOutputs(input: {
  executablePath: string;
  versionOutput: string;
  rootHelp: string;
  execHelp: string;
  approvalProbeExitCode: number | null;
  loginStatusOutput: string;
  loginStatusExitCode: number | null;
  detectedAt?: Date;
}): CodexCapabilitySnapshot {
  const combinedHelp = `${input.rootHelp}\n---EXEC---\n${input.execHelp}`;
  const sandboxModes = (["read-only", "workspace-write", "danger-full-access"] as const).filter(mode => combinedHelp.includes(mode));
  const approvalModes = (["untrusted", "on-request", "never"] as const).filter(mode => input.rootHelp.includes(mode));
  const outputModes = [
    ...(hasOption(input.execHelp, "--json") ? ["jsonl" as const] : []),
    ...(hasOption(input.execHelp, "--output-schema") ? ["output-schema" as const] : []),
    ...(hasOption(input.execHelp, "--output-last-message") ? ["last-message" as const] : [])
  ];
  const version = input.versionOutput.trim().replace(/^codex-cli\s+/i, "");
  const execAvailable = /\bcodex exec\b|Run Codex non-interactively/i.test(input.execHelp);
  const approvalVerified = input.approvalProbeExitCode === 0 && approvalModes.includes("never");
  const unsupportedReasons: string[] = [];
  if (!execAvailable) unsupportedReasons.push("Non-interactive codex exec is unavailable.");
  if (!sandboxModes.includes("workspace-write")) unsupportedReasons.push("workspace-write sandbox mode is unavailable.");
  if (!approvalVerified) unsupportedReasons.push("The non-interactive never approval policy was not verified.");
  if (!outputModes.includes("jsonl")) unsupportedReasons.push("JSONL output is unavailable.");
  if (!hasOption(input.execHelp, "--cd")) unsupportedReasons.push("Working-directory selection is unavailable.");
  if (!version) unsupportedReasons.push("Codex version output was not recognized.");
  const loginText = input.loginStatusOutput.trim();
  const authenticationStatus = /not logged in/i.test(loginText)
    ? "UNAUTHENTICATED"
    : input.loginStatusExitCode === 0 && /logged in/i.test(loginText) ? "AUTHENTICATED" : "UNKNOWN";
  return codexCapabilitySnapshotSchema.parse({
    executorId: "codex-cli",
    executablePath: input.executablePath,
    displayPath: sanitizeExecutableDisplayPath(input.executablePath),
    version,
    detectedAt: (input.detectedAt ?? new Date()).toISOString(),
    execAvailable,
    modelFlag: hasOption(input.execHelp, "--model"),
    reasoningEffortMechanism: "UNKNOWN",
    sandboxModes,
    approvalModes: approvalVerified ? approvalModes : approvalModes.filter(mode => mode !== "never"),
    outputModes,
    workingDirectorySupport: hasOption(input.execHelp, "--cd"),
    timeoutManagedByRelay: true,
    cancellationManagedByRelay: true,
    authenticationStatus,
    rawHelpHash: createHash("sha256").update(combinedHelp, "utf8").digest("hex"),
    supported: unsupportedReasons.length === 0,
    unsupportedReasons
  });
}

export function unavailableCodexSnapshot(reason: string, detectedAt = new Date()): CodexCapabilitySnapshot {
  return codexCapabilitySnapshotSchema.parse({
    executorId: "codex-cli", executablePath: "", displayPath: "Not found", version: "", detectedAt: detectedAt.toISOString(),
    execAvailable: false, modelFlag: false, reasoningEffortMechanism: "UNKNOWN", sandboxModes: [], approvalModes: [], outputModes: [],
    workingDirectorySupport: false, timeoutManagedByRelay: true, cancellationManagedByRelay: true,
    authenticationStatus: "UNAVAILABLE", rawHelpHash: createHash("sha256").update("").digest("hex"), supported: false,
    unsupportedReasons: [reason]
  });
}

export function sanitizeExecutableDisplayPath(executablePath: string, environment: NodeJS.ProcessEnv = process.env): string {
  const candidates: Array<[string | undefined, string]> = [
    [environment.LOCALAPPDATA, "%LOCALAPPDATA%"], [environment.APPDATA, "%APPDATA%"], [environment.USERPROFILE, "%USERPROFILE%"], [environment.HOME, "%HOME%"]
  ];
  for (const [prefix, replacement] of candidates) {
    if (prefix && executablePath.toLocaleLowerCase("en-US").startsWith(prefix.toLocaleLowerCase("en-US"))) return `${replacement}${executablePath.slice(prefix.length)}`;
  }
  return executablePath;
}

export type CodexDiscoveryOptions = { executablePath?: string; environment?: NodeJS.ProcessEnv; runner?: ProcessRunner };

export class CodexCapabilityDiscovery {
  private readonly runner: ProcessRunner;
  private readonly environment: NodeJS.ProcessEnv;

  constructor(private readonly options: CodexDiscoveryOptions = {}) {
    this.runner = options.runner ?? new SafeProcessRunner();
    this.environment = options.environment ?? process.env;
  }

  private async existing(candidate: string): Promise<string | undefined> {
    try { await access(candidate); return await realpath(candidate); } catch { return undefined; }
  }

  async findExecutable(): Promise<string | undefined> {
    const configured = this.options.executablePath ?? this.environment.RELAY_V2_CODEX_PATH;
    if (configured) return this.existing(configured);
    for (const directory of (this.environment.PATH ?? "").split(path.delimiter).filter(Boolean)) {
      for (const name of process.platform === "win32" ? ["codex.exe"] : ["codex"]) {
        const found = await this.existing(path.join(directory, name));
        if (found) return found;
      }
    }
    if (process.platform === "win32" && this.environment.LOCALAPPDATA) {
      const root = path.join(this.environment.LOCALAPPDATA, "OpenAI", "Codex", "bin");
      try {
        const directories = await readdir(root, { withFileTypes: true });
        for (const directory of directories.filter(item => item.isDirectory()).sort((a, b) => b.name.localeCompare(a.name))) {
          const found = await this.existing(path.join(root, directory.name, "codex.exe"));
          if (found) return found;
        }
      } catch {}
    }
    return undefined;
  }

  private async capture(executablePath: string, args: string[]): Promise<CommandCapture> {
    let stdout = "";
    let stderr = "";
    let exitCode: number | null = null;
    for await (const event of this.runner.run({
      executionId: randomUUID(), executablePath, args, cwd: path.dirname(executablePath), timeoutMs: 10_000, maxOutputBytes: 512 * 1024,
      environment: this.environment
    })) {
      if (event.type === "stdout") stdout += event.message;
      else if (event.type === "stderr") stderr += event.message;
      else if (event.type === "exit") exitCode = event.result.exitCode;
    }
    return { stdout, stderr, exitCode };
  }

  async discover(): Promise<CodexCapabilitySnapshot> {
    const executablePath = await this.findExecutable();
    if (!executablePath) return unavailableCodexSnapshot("Codex CLI executable was not found in the configured path, PATH, or local Codex app installation.");
    const [version, root, exec, approval, login] = await Promise.all([
      this.capture(executablePath, ["--version"]),
      this.capture(executablePath, ["--help"]),
      this.capture(executablePath, ["exec", "--help"]),
      this.capture(executablePath, ["-a", "never", "exec", "--help"]),
      this.capture(executablePath, ["login", "status"])
    ]);
    return parseCodexCapabilityOutputs({
      executablePath,
      versionOutput: version.stdout || version.stderr,
      rootHelp: root.stdout || root.stderr,
      execHelp: exec.stdout || exec.stderr,
      approvalProbeExitCode: approval.exitCode,
      loginStatusOutput: `${login.stdout}\n${login.stderr}`,
      loginStatusExitCode: login.exitCode
    });
  }
}
