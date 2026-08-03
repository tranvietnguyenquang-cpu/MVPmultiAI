import { CodexCapabilityDiscovery, runDisposableReadOnlyCodexSmoke } from "@project-relay/relay-v2-execution";

async function main(): Promise<void> {
  if (process.env.RELAY_V2_REAL_CODEX_SMOKE !== "1") {
    console.log("SKIPPED: set RELAY_V2_REAL_CODEX_SMOKE=1 to authorize the disposable read-only Codex smoke test.");
    return;
  }

  const discovery = new CodexCapabilityDiscovery();
  const snapshot = await discovery.discover();
  console.log(JSON.stringify({
    version: snapshot.version, path: snapshot.displayPath, authenticationStatus: snapshot.authenticationStatus,
    supported: snapshot.supported, unsupportedReasons: snapshot.unsupportedReasons
  }, null, 2));
  const result = await runDisposableReadOnlyCodexSmoke(snapshot);
  if (result.status === "SKIPPED") console.log(`SKIPPED: ${result.reason}`);
  else console.log("PASSED: disposable read-only Codex CLI smoke completed with exit code 0.");
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
