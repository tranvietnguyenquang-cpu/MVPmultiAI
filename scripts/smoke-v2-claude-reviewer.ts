import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { redactSecrets } from "@project-relay/local-safety";
import {
  buildRawInvocationStructuralReport, runDisposableReadOnlyClaudeReviewSmoke,
  runUnregisteredClaudeVersionStructuralDiagnostic, type UnregisteredVersionDiagnosticGates
} from "@project-relay/relay-v2-claude-reviewer";

type RawOutcome = { stdout: string; stderr: string; exitCode: number | null; signal: string | null; timedOut: boolean; cancelled: boolean };

// Same sensitive-key shape the structural-diagnostic report redacts by value
// (see structural-diagnostics.ts) -- kept independent here since this capture
// path redacts full *text*, not just typed field summaries.
const SENSITIVE_KEY_PATTERN = /email|account|organi[sz]ation|org[_-]?id|session[_-]?id|user|path|cwd|home|token|credential|cost|usage/i;
const CAPTURE_SIZE_CAP_BYTES = 200_000;

function redactAbsolutePaths(text: string): string {
  return text
    .replace(/[A-Za-z]:\\(?:[^\r\n"\\]+\\)*[^\r\n"\\]+/g, "<redacted-path>")
    .replace(/\/(?:home|Users)\/[^\s"']+/g, "<redacted-path>");
}

function redactJsonValuesRecursively(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactJsonValuesRecursively);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY_PATTERN.test(key.toLowerCase()) ? "<redacted>" : redactJsonValuesRecursively(nested);
    }
    return out;
  }
  if (typeof value === "string") return redactAbsolutePaths(redactSecrets(value));
  return value;
}

function redactRawText(text: string): string {
  const trimmed = text.trim();
  if (trimmed) {
    try {
      return JSON.stringify(redactJsonValuesRecursively(JSON.parse(trimmed)));
    } catch {
      // Not a single JSON value -- fall through to plain text redaction below.
    }
  }
  return redactAbsolutePaths(redactSecrets(text));
}

function capText(text: string, capBytes: number): { text: string; truncated: boolean } {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.byteLength <= capBytes) return { text, truncated: false };
  return { text: buffer.subarray(0, capBytes).toString("utf8"), truncated: true };
}

async function writeRedactedCapture(outcome: RawOutcome): Promise<string> {
  const dir = path.join(process.cwd(), "test-results", "relay-v2-claude-smoke-capture");
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.json`);

  const stdoutCapped = capText(redactRawText(outcome.stdout), CAPTURE_SIZE_CAP_BYTES);
  const stderrCapped = capText(redactRawText(outcome.stderr), CAPTURE_SIZE_CAP_BYTES);

  const capture = {
    capturedAt: new Date().toISOString(),
    process: { exitCode: outcome.exitCode, signal: outcome.signal, timedOut: outcome.timedOut, cancelled: outcome.cancelled },
    stdoutSha256Original: createHash("sha256").update(outcome.stdout, "utf8").digest("hex"),
    stderrSha256Original: createHash("sha256").update(outcome.stderr, "utf8").digest("hex"),
    stdoutByteCountOriginal: Buffer.byteLength(outcome.stdout, "utf8"),
    stderrByteCountOriginal: Buffer.byteLength(outcome.stderr, "utf8"),
    stdoutRedacted: stdoutCapped.text,
    stdoutRedactedTruncated: stdoutCapped.truncated,
    stderrRedacted: stderrCapped.text,
    stderrRedactedTruncated: stderrCapped.truncated
  };
  await writeFile(filePath, JSON.stringify(capture, null, 2), "utf8");
  return filePath;
}

/**
 * Diagnostic-ONLY inspection of a Claude CLI version with no registered
 * wrapper contract. Runs only with all three operator gates present, never
 * produces a verdict, never touches a database, never marks the version
 * supported, and never edits the contract catalog. Its terminal status is
 * `DIAGNOSTIC_ONLY`, never `PASSED`.
 *
 * Returns true when it handled the run (so the normal smoke must not follow).
 */
async function runUnregisteredVersionDiagnostic(gates: UnregisteredVersionDiagnosticGates): Promise<boolean> {
  const result = await runUnregisteredClaudeVersionStructuralDiagnostic({ gates });

  if (result.status === "REFUSED") {
    console.log(`REFUSED: ${result.reason}`);
    return true;
  }
  if (result.status === "SKIPPED") {
    console.log(`UNREGISTERED-VERSION DIAGNOSTIC NOT APPLICABLE: ${result.reason}`);
    // Not applicable is not a failure: fall through to the normal smoke, which
    // is the correct thing to run once the version is registered.
    return false;
  }

  console.log("=== RELAY_V2_CLAUDE_ALLOW_UNREGISTERED_DIAGNOSTIC: unregistered Claude CLI version structural report ===");
  console.log(`observedVersion: ${result.observedVersion}`);
  console.log(`semverToken: ${result.semverToken ?? "(unparseable)"}`);
  console.log(`registeredVersions: ${result.registeredVersions.join(", ")}`);
  console.log(`versionNowSupported: ${String(result.versionNowSupported)} (observing a version never registers it)`);
  if (result.bundleIntegrityFailure) console.log(`BUNDLE INTEGRITY FAILURE: ${result.bundleIntegrityFailure}`);
  console.log("--- raw invocation structural report (sanitized) ---");
  console.log(JSON.stringify(result.structuralReport, null, 2));
  console.log("--- wrapper comparison against the verified contract ---");
  console.log(JSON.stringify(result.wrapperComparison, null, 2));
  console.log("=== END DIAGNOSTIC_ONLY ===");
  console.log(
    result.wrapperComparison.structurallyIdenticalToVerifiedContract
      ? "DIAGNOSTIC_ONLY: the observed wrapper is structurally and semantically identical to the verified contract. This is evidence for registering the version; it is NOT registration, and no review, request, or verdict was created."
      : "DIAGNOSTIC_ONLY: the observed wrapper DIFFERS from the verified contract (see topLevelKeys/fieldTypes/authorityFields above). Registering it must use a distinct contract id or parser version with its own strict schema; the existing parser must not be weakened."
  );
  console.log(result.nextStep);
  return true;
}

async function main(): Promise<void> {
  if (process.env.RELAY_V2_REAL_CLAUDE_REVIEW_SMOKE !== "1") {
    console.log("SKIPPED: set RELAY_V2_REAL_CLAUDE_REVIEW_SMOKE=1 to authorize the disposable read-only Claude CLI review smoke test.");
    return;
  }

  const diagnosticEnabled = process.env.RELAY_V2_CLAUDE_SMOKE_DIAGNOSTIC === "1";

  if (process.env.RELAY_V2_CLAUDE_ALLOW_UNREGISTERED_DIAGNOSTIC === "1") {
    const handled = await runUnregisteredVersionDiagnostic({
      realSmokeAuthorized: true,
      diagnosticEnabled,
      unregisteredVersionAllowed: true
    });
    if (handled) return;
  }

  const captureEnabled = diagnosticEnabled && process.env.RELAY_V2_CLAUDE_SMOKE_CAPTURE_REDACTED === "1";
  const preserveCapture = process.env.RELAY_V2_CLAUDE_SMOKE_PRESERVE_CAPTURE === "1";
  let capturePath: string | undefined;

  const onRawInvocationOutcome = diagnosticEnabled
    ? async (outcome: RawOutcome) => {
        const report = buildRawInvocationStructuralReport(outcome);
        console.log("=== RELAY_V2_CLAUDE_SMOKE_DIAGNOSTIC: structural report (sanitized; no prompt/material/credential content) ===");
        console.log(JSON.stringify(report, null, 2));
        console.log("=== END DIAGNOSTIC ===");
        if (captureEnabled) {
          capturePath = await writeRedactedCapture(outcome);
          console.log(`DIAGNOSTIC CAPTURE (redacted, local-only, gitignored): ${capturePath}`);
        }
      }
    : undefined;

  try {
    const result = await runDisposableReadOnlyClaudeReviewSmoke({ onRawInvocationOutcome });
    if (result.status === "SKIPPED") {
      console.log(`SKIPPED: ${result.reason}`);
      return;
    }
    console.log(`PASSED: disposable read-only Claude CLI review smoke completed (${result.verdict}, reviewedRequestHash=${result.reviewedRequestHash.slice(0, 12)}...).`);
  } finally {
    if (capturePath) {
      if (preserveCapture) {
        console.log(`DIAGNOSTIC CAPTURE preserved at: ${capturePath}`);
      } else {
        await rm(capturePath, { force: true });
        console.log("DIAGNOSTIC CAPTURE deleted (set RELAY_V2_CLAUDE_SMOKE_PRESERVE_CAPTURE=1 to keep it next run).");
      }
    }
  }
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
