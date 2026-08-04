import { describe, expect, it } from "vitest";
import type { ProcessRunRequest, ProcessRunner, ProcessRunnerEvent } from "@project-relay/relay-v2-execution";
import { capabilitySemanticHash, ClaudeCapabilityDiscovery, sanitizeExecutableDisplayPath, toReviewerCapabilityDiagnostic, unavailableClaudeSnapshot } from "./claude-capabilities.js";

const HELP_TEXT = [
  "-p, --print", "--output-format <format>", '"json"', "--json-schema <schema>", "--tools <tools...>", "--safe-mode",
  "--strict-mcp-config", "--no-session-persistence", "--disable-slash-commands"
].join(" ");

class ScriptedRunner implements ProcessRunner {
  constructor(private readonly byArg: Record<string, { stdout?: string; stderr?: string; exitCode?: number }>) {}
  owns(): boolean { return false; }
  async cancel(): Promise<boolean> { return true; }
  async *run(request: ProcessRunRequest): AsyncIterable<ProcessRunnerEvent> {
    const key = request.args[0] === "auth" ? "auth" : (request.args[0] ?? "");
    const scripted = this.byArg[key] ?? { stdout: "", exitCode: 0 };
    if (scripted.stdout) yield { type: "stdout", message: scripted.stdout };
    if (scripted.stderr) yield { type: "stderr", message: scripted.stderr };
    yield { type: "exit", result: { exitCode: scripted.exitCode ?? 0, signal: null, timedOut: false, cancelled: false, outputTruncated: false, stdoutBytes: 0, stderrBytes: 0 } };
  }
}

describe("ClaudeCapabilityDiscovery", () => {
  it("reports UNAVAILABLE when no executable can be found", async () => {
    const discovery = new ClaudeCapabilityDiscovery({ environment: { PATH: "" } });
    const snapshot = await discovery.discover();
    expect(snapshot.supported).toBe(false);
    expect(snapshot.authenticationStatus).toBe("UNAVAILABLE");
  });

  it("marks the CLI supported and authenticated when every verified flag is present and auth status is a claude.ai subscription", async () => {
    const runner = new ScriptedRunner({
      "--version": { stdout: "2.1.220 (Claude Code)" },
      "--help": { stdout: HELP_TEXT },
      auth: { stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }), exitCode: 0 }
    });
    const discovery = new ClaudeCapabilityDiscovery({ executablePath: process.execPath, runner });
    const snapshot = await discovery.discover();
    expect(snapshot.supported).toBe(true);
    expect(snapshot.authenticationStatus).toBe("AUTHENTICATED");
    expect(snapshot.version).toBe("2.1.220 (Claude Code)");
  });

  it("marks unsupported when authenticated via an API key instead of a subscription session", async () => {
    const runner = new ScriptedRunner({
      "--version": { stdout: "2.1.220" },
      "--help": { stdout: HELP_TEXT },
      auth: { stdout: JSON.stringify({ loggedIn: true, authMethod: "apiKey" }), exitCode: 0 }
    });
    const discovery = new ClaudeCapabilityDiscovery({ executablePath: process.execPath, runner });
    const snapshot = await discovery.discover();
    expect(snapshot.supported).toBe(false);
    expect(snapshot.unsupportedReasons.join(" ")).toMatch(/subscription/i);
  });

  it("reports UNAUTHENTICATED distinctly from UNKNOWN", async () => {
    const loggedOut = new ClaudeCapabilityDiscovery({
      executablePath: process.execPath,
      runner: new ScriptedRunner({ "--version": { stdout: "2.1.220" }, "--help": { stdout: HELP_TEXT }, auth: { stdout: JSON.stringify({ loggedIn: false }), exitCode: 0 } })
    });
    expect((await loggedOut.discover()).authenticationStatus).toBe("UNAUTHENTICATED");

    const unknown = new ClaudeCapabilityDiscovery({
      executablePath: process.execPath,
      runner: new ScriptedRunner({ "--version": { stdout: "2.1.220" }, "--help": { stdout: HELP_TEXT }, auth: { stdout: "not json", exitCode: 1 } })
    });
    expect((await unknown.discover()).authenticationStatus).toBe("UNKNOWN");
  });

  it("marks unsupported and lists reasons when a required flag is missing from --help", async () => {
    const runner = new ScriptedRunner({
      "--version": { stdout: "2.1.220" },
      "--help": { stdout: "-p, --print --output-format <format> \"json\"" }, // missing --json-schema, --tools, --safe-mode, --strict-mcp-config
      auth: { stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }), exitCode: 0 }
    });
    const discovery = new ClaudeCapabilityDiscovery({ executablePath: process.execPath, runner });
    const snapshot = await discovery.discover();
    expect(snapshot.supported).toBe(false);
    expect(snapshot.unsupportedReasons.length).toBeGreaterThan(0);
  });

  it("computes a stable, non-empty executable identity hash for a real resolved file", async () => {
    const runner = new ScriptedRunner({
      "--version": { stdout: "2.1.220" }, "--help": { stdout: HELP_TEXT },
      auth: { stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }), exitCode: 0 }
    });
    const discovery = new ClaudeCapabilityDiscovery({ executablePath: process.execPath, runner });
    const snapshot = await discovery.discover();
    expect(snapshot.executableIdentityHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("resolves the registered wrapper contract id/parser version for the one supported CLI version", async () => {
    const runner = new ScriptedRunner({
      "--version": { stdout: "2.1.220" }, "--help": { stdout: HELP_TEXT },
      auth: { stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }), exitCode: 0 }
    });
    const discovery = new ClaudeCapabilityDiscovery({ executablePath: process.execPath, runner });
    const snapshot = await discovery.discover();
    expect(snapshot.wrapperContractId).toBe("claude-json-schema-result-v1");
    expect(snapshot.wrapperParserVersion).toBe("1");
  });

  it("leaves the wrapper contract id/parser version empty (never fabricated) for an unregistered CLI version", async () => {
    const runner = new ScriptedRunner({
      "--version": { stdout: "9.9.9" }, "--help": { stdout: HELP_TEXT },
      auth: { stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }), exitCode: 0 }
    });
    const discovery = new ClaudeCapabilityDiscovery({ executablePath: process.execPath, runner });
    const snapshot = await discovery.discover();
    expect(snapshot.wrapperContractId).toBe("");
    expect(snapshot.wrapperParserVersion).toBe("");
    expect(snapshot.supported).toBe(false);
  });
});

describe("capabilitySemanticHash", () => {
  it("changes when wrapperContractId or wrapperParserVersion changes, even with every other field identical", () => {
    const base = toReviewerCapabilityDiagnostic({
      ...unavailableClaudeSnapshot("placeholder"), supported: true, authenticationStatus: "AUTHENTICATED",
      wrapperContractId: "claude-json-schema-result-v1", wrapperParserVersion: "1", executableIdentityHash: "a".repeat(64), helpHash: "b".repeat(64)
    });
    const baseline = capabilitySemanticHash(base);
    expect(capabilitySemanticHash({ ...base, wrapperContractId: "some-other-contract" })).not.toBe(baseline);
    expect(capabilitySemanticHash({ ...base, wrapperParserVersion: "2" })).not.toBe(baseline);
  });
});

describe("sanitizeExecutableDisplayPath", () => {
  it("redacts a known LOCALAPPDATA-prefixed npm install path to a symbolic form with no username", () => {
    const environment = { LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local" };
    const raw = "C:\\Users\\alice\\AppData\\Local\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe";
    const result = sanitizeExecutableDisplayPath(raw, environment);
    expect(result).not.toContain("alice");
    expect(result).not.toContain("C:\\Users");
    expect(result).toContain("%LOCALAPPDATA%");
  });

  it("collapses an arbitrary company-named drive path to basename-only, never the raw absolute path", () => {
    const result = sanitizeExecutableDisplayPath("D:\\CompanySecret\\Tools\\claude.exe", {});
    expect(result).toBe("<custom-location>/claude.exe");
    expect(result).not.toContain("CompanySecret");
    expect(result).not.toContain("D:");
  });

  it("collapses a UNC path to basename-only, never the host or share name", () => {
    const result = sanitizeExecutableDisplayPath("\\\\fileserver\\shared\\tools\\claude.exe", {});
    expect(result).toBe("<custom-location>/claude.exe");
    expect(result).not.toContain("fileserver");
    expect(result).not.toContain("shared");
  });

  it("redacts a custom (non-default) APPDATA prefix without leaking the username segment", () => {
    const environment = { APPDATA: "C:\\Users\\bob.smith\\AppData\\Roaming" };
    const raw = "C:\\Users\\bob.smith\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe";
    const result = sanitizeExecutableDisplayPath(raw, environment);
    expect(result).not.toContain("bob.smith");
    expect(result).toContain("%APPDATA%");
  });

  it("redacts a Unicode username under USERPROFILE without leaking it", () => {
    const environment = { USERPROFILE: "C:\\Users\\Jos\u00e9" };
    const raw = "C:\\Users\\Jos\u00e9\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe";
    const result = sanitizeExecutableDisplayPath(raw, environment);
    expect(result).not.toContain("Jos\u00e9");
    expect(result).toContain("%USERPROFILE%");
  });

  it("collapses an operator RELAY_V2_CLAUDE_PATH override outside any known prefix to basename-only", () => {
    const result = sanitizeExecutableDisplayPath("C:\\ops\\custom-claude-install\\claude.exe", {});
    expect(result).toBe("<custom-location>/claude.exe");
    expect(result).not.toContain("ops");
    expect(result).not.toContain("custom-claude-install");
  });

  it("never contains a drive root, USERPROFILE, APPDATA, or LOCALAPPDATA raw value across every case above", () => {
    const environment = { LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local", APPDATA: "C:\\Users\\alice\\AppData\\Roaming", USERPROFILE: "C:\\Users\\alice", HOME: "/home/alice" };
    const cases = [
      "C:\\Users\\alice\\AppData\\Local\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe",
      "D:\\CompanySecret\\Tools\\claude.exe",
      "\\\\fileserver\\shared\\claude.exe",
      "/home/alice/.local/bin/claude"
    ];
    for (const rawPath of cases) {
      const result = sanitizeExecutableDisplayPath(rawPath, environment);
      expect(result, rawPath).not.toContain("alice");
      expect(result, rawPath).not.toMatch(/^[A-Za-z]:\\/);
      expect(result, rawPath).not.toContain("CompanySecret");
      expect(result, rawPath).not.toContain("fileserver");
    }
  });
});

describe("toReviewerCapabilityDiagnostic", () => {
  it("never exposes the raw executable path, only the sanitized displayPath", () => {
    const snapshot = unavailableClaudeSnapshot("not found");
    const diagnostic = toReviewerCapabilityDiagnostic({ ...snapshot, executablePath: "C:\\Users\\someone\\AppData\\Roaming\\npm\\claude.exe" });
    expect(JSON.stringify(diagnostic)).not.toContain("someone");
    expect(diagnostic).not.toHaveProperty("executablePath");
  });

  it("sets expiresAt after detectedAt, giving the diagnostic a bounded freshness window", () => {
    const snapshot = unavailableClaudeSnapshot("not found", new Date("2026-08-03T00:00:00.000Z"));
    const diagnostic = toReviewerCapabilityDiagnostic(snapshot, 60_000);
    expect(new Date(diagnostic.expiresAt).getTime()).toBeGreaterThan(new Date(diagnostic.detectedAt).getTime());
  });
});
