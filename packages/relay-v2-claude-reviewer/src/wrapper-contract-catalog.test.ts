import { describe, expect, it } from "vitest";
import type { ProcessRunRequest, ProcessRunner, ProcessRunnerEvent } from "@project-relay/relay-v2-execution";
import { ClaudeCapabilityDiscovery } from "./claude-capabilities.js";
import { CLAUDE_CLI_REFERENCE_WRAPPER_VERSION, resolveClaudeWrapperContract, SUPPORTED_CLAUDE_WRAPPER_CONTRACTS, SUPPORTED_CLAUDE_WRAPPER_VERSIONS } from "./wrapper-contract-catalog.js";

const HELP_TEXT = [
  "-p, --print", "--output-format <format>", '"json"', "--json-schema <schema>", "--tools <tools...>", "--safe-mode",
  "--strict-mcp-config", "--no-session-persistence", "--disable-slash-commands"
].join(" ");

class ScriptedRunner implements ProcessRunner {
  constructor(private readonly version: string) {}
  owns(): boolean { return false; }
  async cancel(): Promise<boolean> { return true; }
  async *run(request: ProcessRunRequest): AsyncIterable<ProcessRunnerEvent> {
    if (request.args[0] === "--version") { yield { type: "stdout", message: this.version }; }
    else if (request.args[0] === "--help") { yield { type: "stdout", message: HELP_TEXT }; }
    else if (request.args[0] === "auth") { yield { type: "stdout", message: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }) }; }
    yield { type: "exit", result: { exitCode: 0, signal: null, timedOut: false, cancelled: false, outputTruncated: false, stdoutBytes: 0, stderrBytes: 0 } };
  }
}

async function discoverWithVersion(version: string) {
  const discovery = new ClaudeCapabilityDiscovery({ executablePath: process.execPath, runner: new ScriptedRunner(version) });
  return discovery.discover();
}

describe("SUPPORTED_CLAUDE_WRAPPER_CONTRACTS catalog", () => {
  it("resolves the registered version 2.1.220", () => {
    expect(resolveClaudeWrapperContract("2.1.220")).toEqual({ contractId: "claude-json-schema-result-v1", parserVersion: "1" });
    expect(CLAUDE_CLI_REFERENCE_WRAPPER_VERSION).toBe("2.1.220");
  });

  it("resolves the registered version 2.1.221 to the SAME verified contract, after its wrapper was observed to be identical", () => {
    expect(resolveClaudeWrapperContract("2.1.221")).toEqual({ contractId: "claude-json-schema-result-v1", parserVersion: "1" });
    // Same wrapper shape means the same contract id and parser version -- one
    // verified transport contract backing two observed versions, never two
    // divergent parsers.
    expect(resolveClaudeWrapperContract("2.1.221")).toEqual(resolveClaudeWrapperContract("2.1.220"));
  });

  it("never resolves an unobserved patch release, a newer minor/major, or an unknown version", () => {
    // 2.1.222 is the version immediately after the newest registered one:
    // registering 2.1.221 recorded an observation, never a prediction that
    // later patch releases keep the same wrapper.
    expect(resolveClaudeWrapperContract("2.1.222")).toBeUndefined();
    expect(resolveClaudeWrapperContract("2.2.0")).toBeUndefined();
    expect(resolveClaudeWrapperContract("3.0.0")).toBeUndefined();
    expect(resolveClaudeWrapperContract("2.1.219")).toBeUndefined();
    expect(resolveClaudeWrapperContract("not-a-version")).toBeUndefined();
    expect(resolveClaudeWrapperContract("")).toBeUndefined();
  });

  it("matches exactly, never by range, prefix, or truncation", () => {
    for (const near of ["2.1.22", "2.1.2210", "2.1.221 ", " 2.1.221", "v2.1.221", "2.1.221-beta", "^2.1.221", ">=2.1.220"]) {
      expect(resolveClaudeWrapperContract(near)).toBeUndefined();
    }
  });

  it("exposes exactly the two observed, registered versions (no speculative widening)", () => {
    expect(Object.keys(SUPPORTED_CLAUDE_WRAPPER_CONTRACTS).sort()).toEqual(["2.1.220", "2.1.221"]);
    expect(SUPPORTED_CLAUDE_WRAPPER_VERSIONS).toEqual(["2.1.220", "2.1.221"]);
  });
});

describe("ClaudeCapabilityDiscovery wrapper-contract enforcement", () => {
  it("accepts 2.1.220 with real-CLI version-banner decoration", async () => {
    const snapshot = await discoverWithVersion("2.1.220 (Claude Code)");
    expect(snapshot.supported).toBe(true);
  });

  it("accepts 2.1.221, binding it to the same verified wrapper contract", async () => {
    const snapshot = await discoverWithVersion("2.1.221 (Claude Code)");
    expect(snapshot.supported).toBe(true);
    expect(snapshot.wrapperContractId).toBe("claude-json-schema-result-v1");
    expect(snapshot.wrapperParserVersion).toBe("1");
    // The CLI version itself stays bound and distinct -- a shared wrapper
    // contract never collapses two versions into one identity.
    expect(snapshot.version).toBe("2.1.221 (Claude Code)");
  });

  it("rejects an unobserved patch release 2.1.222 before any process would ever be spawned for a review", async () => {
    const snapshot = await discoverWithVersion("2.1.222");
    expect(snapshot.supported).toBe(false);
    expect(snapshot.unsupportedReasons.join(" ")).toMatch(/no registered, locally-verified wrapper contract/i);
  });

  it("rejects a newer minor version 2.2.0", async () => {
    const snapshot = await discoverWithVersion("2.2.0");
    expect(snapshot.supported).toBe(false);
    expect(snapshot.unsupportedReasons.join(" ")).toMatch(/wrapper contract/i);
  });

  it("rejects an unrecognized/unparseable version string", async () => {
    const snapshot = await discoverWithVersion("nightly-build");
    expect(snapshot.supported).toBe(false);
    expect(snapshot.unsupportedReasons.join(" ")).toMatch(/wrapper contract/i);
  });
});
