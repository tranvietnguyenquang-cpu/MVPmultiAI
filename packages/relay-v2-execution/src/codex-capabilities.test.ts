import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CodexCapabilityDiscovery,
  parseCodexCapabilityOutputs,
  sanitizeExecutableDisplayPath,
  toCodexDiagnosticsDto,
  unavailableCodexSnapshot
} from "./codex-capabilities.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "test-fixtures");

describe("Codex capability discovery", () => {
  it("parses only capabilities present in captured local help", async () => {
    const [versionOutput, rootHelp, execHelp] = await Promise.all([
      readFile(path.join(fixtures, "codex-version.txt"), "utf8"),
      readFile(path.join(fixtures, "codex-root-help.txt"), "utf8"),
      readFile(path.join(fixtures, "codex-exec-help.txt"), "utf8")
    ]);
    const snapshot = parseCodexCapabilityOutputs({
      executablePath: "C:\\Users\\person\\AppData\\Local\\OpenAI\\Codex\\bin\\build\\codex.exe",
      versionOutput, rootHelp, execHelp, approvalProbeExitCode: 0,
      loginStatusOutput: "Not logged in", loginStatusExitCode: 1,
      detectedAt: new Date("2026-08-02T00:00:00.000Z")
    });
    expect(snapshot).toMatchObject({
      version: "0.146.0-alpha.9.2", execAvailable: true, modelFlag: true,
      reasoningEffortMechanism: "UNKNOWN", sandboxModes: ["read-only", "workspace-write", "danger-full-access"],
      approvalModes: ["untrusted", "on-request", "never"], outputModes: ["jsonl", "output-schema", "last-message"],
      workingDirectorySupport: true, authenticationStatus: "UNAUTHENTICATED", supported: true
    });
    expect(snapshot.rawHelpHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("does not invent an omitted flag or reasoning mechanism", () => {
    const snapshot = parseCodexCapabilityOutputs({
      executablePath: "/opt/codex", versionOutput: "codex-cli 1.0", rootHelp: "never workspace-write",
      execHelp: "Run Codex non-interactively --json --cd", approvalProbeExitCode: 0,
      loginStatusOutput: "unknown", loginStatusExitCode: 2
    });
    expect(snapshot.modelFlag).toBe(false);
    expect(snapshot.reasoningEffortMechanism).toBe("UNKNOWN");
    expect(snapshot.outputModes).toEqual(["jsonl"]);
  });

  it("represents executable absence without a fabricated path", async () => {
    const snapshot = unavailableCodexSnapshot("Executable not found.");
    expect(snapshot).toMatchObject({ executablePath: "", authenticationStatus: "UNAVAILABLE", supported: false });
    const discovery = new CodexCapabilityDiscovery({ executablePath: path.join(fixtures, "missing-codex.exe"), environment: {} });
    expect(await discovery.findExecutable()).toBeUndefined();
  });

  it("sanitizes user-profile path prefixes", () => {
    expect(sanitizeExecutableDisplayPath("C:\\Users\\person\\AppData\\Local\\OpenAI\\Codex\\codex.exe", {
      LOCALAPPDATA: "C:\\Users\\person\\AppData\\Local", USERPROFILE: "C:\\Users\\person"
    })).toBe("%LOCALAPPDATA%\\OpenAI\\Codex\\codex.exe");
  });

  it("projects diagnostics without the server-only executable path", () => {
    const snapshot = unavailableCodexSnapshot("not found");
    const diagnostic = toCodexDiagnosticsDto(snapshot);
    expect(diagnostic.displayPath).toBe("Not found");
    expect(diagnostic).not.toHaveProperty("executablePath");
    expect(diagnostic).toMatchObject({
      authenticationEvidence: "CODEX_LOGIN_STATUS",
      realExecutionReadiness: "NOT_PROVEN"
    });
  });
});
