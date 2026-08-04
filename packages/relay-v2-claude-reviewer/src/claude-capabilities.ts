import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import path from "node:path";
import { canonicalJson, type ReviewerCapabilityDiagnostic } from "@project-relay/relay-v2-domain";
import { SafeProcessRunner, type ProcessRunner } from "@project-relay/relay-v2-execution";
import { z } from "zod";
import { ClaudeExecutableResolver } from "./claude-executable-resolver.js";
import { claudeSemverToken, resolveClaudeWrapperContract, unregisteredWrapperContractReason } from "./wrapper-contract-catalog.js";

const sha256HexOrEmpty = /^([a-f0-9]{64})?$/;

/**
 * Rich, internal capability snapshot for the Claude CLI. Only the sanitized
 * subset in `toReviewerCapabilityDiagnostic` ever crosses into the reviewer-
 * agnostic ReviewEngine/API/UI layer; this full shape is for ClaudeCliReviewer's
 * own internal use (deciding whether it is safe to invoke the real CLI at all).
 */
export const claudeCapabilitySnapshotSchema = z.object({
  reviewerId: z.literal("claude-cli"),
  executablePath: z.string(),
  displayPath: z.string(),
  version: z.string(),
  detectedAt: z.string().datetime(),
  printSupported: z.boolean(),
  outputFormatJsonSupported: z.boolean(),
  jsonSchemaSupported: z.boolean(),
  toolsFlagSupported: z.boolean(),
  safeModeSupported: z.boolean(),
  strictMcpConfigSupported: z.boolean(),
  noSessionPersistenceSupported: z.boolean(),
  disableSlashCommandsSupported: z.boolean(),
  authenticationStatus: z.enum(["AUTHENTICATED", "UNAUTHENTICATED", "UNKNOWN", "UNAVAILABLE"]),
  authMethod: z.string(),
  executableIdentityHash: z.string().regex(sha256HexOrEmpty),
  helpHash: z.string().regex(sha256HexOrEmpty),
  /** The exact wrapper contract this CLI version resolved to via the version-to-wrapper catalog (see wrapper-contract-catalog.ts), or "" if unresolved/unsupported. */
  wrapperContractId: z.string(),
  wrapperParserVersion: z.string(),
  supported: z.boolean(),
  unsupportedReasons: z.array(z.string())
}).strict();
export type ClaudeCapabilitySnapshot = z.infer<typeof claudeCapabilitySnapshotSchema>;

const CAPABILITY_FRESHNESS_MS = 5 * 60_000;

export function toReviewerCapabilityDiagnostic(snapshot: ClaudeCapabilitySnapshot, freshnessMs = CAPABILITY_FRESHNESS_MS): ReviewerCapabilityDiagnostic {
  const detected = new Date(snapshot.detectedAt);
  return {
    reviewerId: snapshot.reviewerId,
    displayPath: snapshot.displayPath,
    version: snapshot.version,
    authenticationStatus: snapshot.authenticationStatus,
    authenticationEvidence: "CLAUDE_AUTH_STATUS_JSON",
    supported: snapshot.supported,
    unsupportedReasons: snapshot.unsupportedReasons,
    executableIdentityHash: snapshot.executableIdentityHash,
    helpHash: snapshot.helpHash,
    wrapperContractId: snapshot.wrapperContractId,
    wrapperParserVersion: snapshot.wrapperParserVersion,
    detectedAt: snapshot.detectedAt,
    expiresAt: new Date(detected.getTime() + freshnessMs).toISOString()
  };
}

/**
 * A hash of exactly the semantically meaningful capability fields --
 * deliberately excluding `detectedAt`/`expiresAt`, which change on every
 * discovery call regardless of whether anything about the CLI itself
 * changed. Used both to bind `ClaudeReviewerConfig.capabilitySnapshotHash` at
 * request time (`buildClaudeReviewerConfig`) and to detect live drift
 * immediately before every real invocation (`ClaudeCliReviewer`) -- hashing
 * the full diagnostic (including its timestamps) would make every live
 * recheck report spurious drift even when nothing capability-relevant
 * changed.
 */
export function capabilitySemanticHash(diagnostic: ReviewerCapabilityDiagnostic): string {
  return createHash("sha256").update(canonicalJson({
    reviewerId: diagnostic.reviewerId, version: diagnostic.version, authenticationStatus: diagnostic.authenticationStatus,
    supported: diagnostic.supported, unsupportedReasons: diagnostic.unsupportedReasons,
    executableIdentityHash: diagnostic.executableIdentityHash, helpHash: diagnostic.helpHash,
    // A deployment remapping the same CLI version string to a different
    // verified wrapper contract/parser (or a capability refresh that
    // resolves to no contract at all) must invalidate every request bound to
    // the old capabilitySnapshotHash -- these two fields are exactly as
    // semantically meaningful as executableIdentityHash/helpHash above.
    wrapperContractId: diagnostic.wrapperContractId, wrapperParserVersion: diagnostic.wrapperParserVersion
  }), "utf8").digest("hex");
}

export function unavailableClaudeSnapshot(reason: string, detectedAt = new Date()): ClaudeCapabilitySnapshot {
  return claudeCapabilitySnapshotSchema.parse({
    reviewerId: "claude-cli", executablePath: "", displayPath: "Not found", version: "", detectedAt: detectedAt.toISOString(),
    printSupported: false, outputFormatJsonSupported: false, jsonSchemaSupported: false, toolsFlagSupported: false,
    safeModeSupported: false, strictMcpConfigSupported: false, noSessionPersistenceSupported: false, disableSlashCommandsSupported: false,
    authenticationStatus: "UNAVAILABLE", authMethod: "unknown", executableIdentityHash: "", helpHash: createHash("sha256").update("").digest("hex"),
    wrapperContractId: "", wrapperParserVersion: "",
    supported: false, unsupportedReasons: [reason]
  });
}

function hasOption(help: string, option: string): boolean {
  return help.includes(option);
}

async function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", chunk => hash.update(chunk as Buffer));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

type CommandCapture = { stdout: string; stderr: string; exitCode: number | null };

export type ClaudeDiscoveryOptions = { executablePath?: string; environment?: NodeJS.ProcessEnv; runner?: ProcessRunner };

/**
 * Capability-validated discovery for the local Claude Code CLI, mirroring
 * CodexCapabilityDiscovery: never assumes a flag exists -- every capability
 * is derived from the actual local `--help`/`auth status` output captured via
 * SafeProcessRunner (absolute path, argv array, shell:false). No prompt or
 * review material ever passes through this class; it only runs harmless,
 * non-generative diagnostic subcommands.
 */
export class ClaudeCapabilityDiscovery {
  private readonly runner: ProcessRunner;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly resolver: ClaudeExecutableResolver;

  constructor(private readonly options: ClaudeDiscoveryOptions = {}) {
    this.runner = options.runner ?? new SafeProcessRunner();
    this.environment = options.environment ?? process.env;
    this.resolver = new ClaudeExecutableResolver(this.environment);
  }

  async findExecutable(): Promise<string | undefined> {
    return this.options.executablePath ? this.options.executablePath : this.resolver.findExecutable();
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

  async discover(): Promise<ClaudeCapabilitySnapshot> {
    const executablePath = await this.findExecutable();
    if (!executablePath) return unavailableClaudeSnapshot("Claude CLI executable was not found via RELAY_V2_CLAUDE_PATH, PATH, or a verifiable npm shim.");

    const [version, root, auth] = await Promise.all([
      this.capture(executablePath, ["--version"]),
      this.capture(executablePath, ["--help"]),
      this.capture(executablePath, ["auth", "status", "--json"])
    ]);

    const help = root.stdout || root.stderr;
    const versionText = (version.stdout || version.stderr).trim();
    const printSupported = /-p,\s*--print|--print\b/.test(help);
    const outputFormatJsonSupported = hasOption(help, "--output-format") && /"json"/.test(help);
    const jsonSchemaSupported = hasOption(help, "--json-schema");
    const toolsFlagSupported = hasOption(help, "--tools ");
    const safeModeSupported = hasOption(help, "--safe-mode");
    const strictMcpConfigSupported = hasOption(help, "--strict-mcp-config");
    const noSessionPersistenceSupported = hasOption(help, "--no-session-persistence");
    const disableSlashCommandsSupported = hasOption(help, "--disable-slash-commands");

    let authenticationStatus: ClaudeCapabilitySnapshot["authenticationStatus"] = "UNKNOWN";
    let authMethod = "unknown";
    const unsupportedReasons: string[] = [];
    if (auth.exitCode === 0 && auth.stdout.trim()) {
      try {
        const parsedAuth = JSON.parse(auth.stdout) as { loggedIn?: unknown; authMethod?: unknown };
        authMethod = typeof parsedAuth.authMethod === "string" ? parsedAuth.authMethod : "unknown";
        if (parsedAuth.loggedIn === true) {
          authenticationStatus = "AUTHENTICATED";
          if (authMethod !== "claude.ai") {
            authenticationStatus = "UNKNOWN";
            unsupportedReasons.push("Claude CLI is not authenticated via a claude.ai subscription session.");
          }
        } else if (parsedAuth.loggedIn === false) {
          authenticationStatus = "UNAUTHENTICATED";
        }
      } catch {
        authenticationStatus = "UNKNOWN";
      }
    }

    // Every one of these is a mandatory capability for an AUTHORITATIVE
    // review's actual invocation controls (buildClaudeReviewArgv uses every
    // one of these flags unconditionally) -- there is deliberately no
    // "recommended but optional" tier. UNKNOWN (auth) or false (every flag)
    // is always treated as unsupported, never silently allowed through.
    if (!printSupported) unsupportedReasons.push("Non-interactive print mode (-p/--print) is unavailable.");
    if (!outputFormatJsonSupported) unsupportedReasons.push("JSON output format is unavailable.");
    if (!jsonSchemaSupported) unsupportedReasons.push("JSON Schema structured-output enforcement is unavailable.");
    if (!toolsFlagSupported) unsupportedReasons.push("The --tools flag (required to deny all tools) is unavailable.");
    if (!safeModeSupported) unsupportedReasons.push("--safe-mode is unavailable.");
    if (!strictMcpConfigSupported) unsupportedReasons.push("--strict-mcp-config is unavailable.");
    if (!noSessionPersistenceSupported) unsupportedReasons.push("--no-session-persistence is unavailable.");
    if (!disableSlashCommandsSupported) unsupportedReasons.push("--disable-slash-commands is unavailable.");
    if (!versionText) unsupportedReasons.push("Claude CLI version output was not recognized.");
    // A basic positive identity signal (never a substitute for the flag checks
    // above): the combined version/help output must contain a recognizable
    // "Claude Code" banner, so an unrelated or malicious executable that
    // merely happens to expose similarly-named flags is not treated as
    // supported. This is a real (if soft) signal check, not a hardcoded
    // version pin -- it does not assume any particular version string.
    if (!/claude code/i.test(`${versionText} ${help}`)) unsupportedReasons.push("The executable's version/help output does not identify itself as Claude Code.");
    if (authenticationStatus !== "AUTHENTICATED") unsupportedReasons.push("Claude CLI is not authenticated with a subscription session.");

    // Flag/help-based capability detection above proves the CLI *exposes*
    // the right options, but says nothing about whether its structured-output
    // JSON transport wrapper still matches what verdict-parser.ts was built
    // and verified against. That is a separate, exact-version check against
    // SUPPORTED_CLAUDE_WRAPPER_CONTRACTS: an unregistered version (an older
    // release, an untested patch release like 2.1.221, or an unrecognized/
    // unparseable version string) is always unsupported here, before any
    // process is ever spawned for a real review -- never a semver-range or
    // "assume patch releases are compatible" check.
    // `--version` output may carry trailing decoration (e.g. "2.1.220 (Claude
    // Code)"); only the leading semver-shaped token is used for the exact
    // catalog match -- the full, undecorated versionText is still what is
    // stored/reported/bound everywhere else (snapshot.version).
    const semverToken = claudeSemverToken(versionText);
    const wrapperContract = semverToken ? resolveClaudeWrapperContract(semverToken) : undefined;
    if (!wrapperContract) unsupportedReasons.push(unregisteredWrapperContractReason(versionText));

    const executableIdentityHash = await hashFile(executablePath).catch(() => "");
    return claudeCapabilitySnapshotSchema.parse({
      reviewerId: "claude-cli", executablePath, displayPath: sanitizeExecutableDisplayPath(executablePath, this.environment),
      version: versionText, detectedAt: new Date().toISOString(),
      printSupported, outputFormatJsonSupported, jsonSchemaSupported, toolsFlagSupported,
      safeModeSupported, strictMcpConfigSupported, noSessionPersistenceSupported, disableSlashCommandsSupported,
      authenticationStatus, authMethod, executableIdentityHash,
      helpHash: createHash("sha256").update(help, "utf8").digest("hex"),
      wrapperContractId: wrapperContract?.contractId ?? "", wrapperParserVersion: wrapperContract?.parserVersion ?? "",
      supported: unsupportedReasons.length === 0, unsupportedReasons
    });
  }
}

/**
 * Never returns an arbitrary absolute path, drive root, UNC host, username,
 * or organization/project folder name -- only a fixed, non-identifying
 * symbolic form. A path under a known npm/user-profile install location is
 * rendered as `%KNOWN_PREFIX%\node_modules\...` (still zero information
 * about the actual username, since the prefix itself is redacted to its
 * symbolic name and only the well-known, Claude-specific
 * `node_modules\@anthropic-ai\claude-code\...` suffix -- if present -- is
 * kept); anything else collapses to just the basename behind a fixed,
 * clearly-labeled placeholder. This function's output is the *only* form of
 * the executable path ever allowed to reach a persisted ReviewerCapabilitySnapshot,
 * an API response, or the UI.
 */
export function sanitizeExecutableDisplayPath(executablePath: string, environment: NodeJS.ProcessEnv = process.env): string {
  const normalized = executablePath.replace(/\\/g, "/");
  const lowerNormalized = normalized.toLocaleLowerCase("en-US");
  const knownPrefixes: Array<[string | undefined, string]> = [
    [environment.LOCALAPPDATA, "%LOCALAPPDATA%"], [environment.APPDATA, "%APPDATA%"], [environment.USERPROFILE, "%USERPROFILE%"], [environment.HOME, "%HOME%"]
  ];
  for (const [prefix, replacement] of knownPrefixes) {
    if (!prefix) continue;
    const normalizedPrefix = prefix.replace(/\\/g, "/").toLocaleLowerCase("en-US");
    if (lowerNormalized.startsWith(normalizedPrefix)) {
      const suffixMatch = /node_modules\/@anthropic-ai\/claude-code\/.+$/i.exec(normalized.slice(prefix.length));
      return suffixMatch ? `${replacement}/${suffixMatch[0]}` : `${replacement}/.../${path.basename(executablePath)}`;
    }
  }
  // No known prefix matched: this is either an operator override pointing
  // somewhere else entirely, a UNC path, or an install location this
  // function does not otherwise recognize. In every one of those cases the
  // only thing ever surfaced is the basename behind a fixed, unmistakable
  // placeholder label -- never the drive letter, host, share name, username,
  // or any organization/project folder segment from the real path.
  return `<custom-location>/${path.basename(executablePath)}`;
}
