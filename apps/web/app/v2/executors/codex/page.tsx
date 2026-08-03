import { notFound } from "next/navigation";
import { RelayV2CodexDiagnostics } from "../../../../components/relay-v2/codex-diagnostics";
import { getRelayV2ExecutionServices, isRelayV2ExecutionEnabled } from "../../../../lib/relay-v2/server";

export const dynamic = "force-dynamic";
export default async function RelayV2CodexDiagnosticsPage() {
  if (!isRelayV2ExecutionEnabled()) notFound();
  const latest = await (await getRelayV2ExecutionServices()).engine.latestExecutorCapability("codex-cli");
  const parsed = latest as Parameters<typeof RelayV2CodexDiagnostics>[0]["initial"];
  return <><div className="eyebrow">Relay v2 / Executors</div><h1>Codex CLI</h1><p className="subtle">Relay discovers only capabilities verified from the locally installed CLI. AUTO omits unverified model and reasoning overrides.</p><div className="grid"><RelayV2CodexDiagnostics {...(parsed ? { initial: parsed } : {})}/></div></>;
}
