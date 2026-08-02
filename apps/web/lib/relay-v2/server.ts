import type { NextRequest } from "next/server";
import { getRelayV2Database } from "@project-relay/relay-v2-persistence";
import { RelayV2Orchestrator } from "@project-relay/relay-v2-orchestrator";
import { ExecutionArtifactStore, ExecutionEngine, ExecutionRuntimeHost, FakeExecutor } from "@project-relay/relay-v2-execution";
import { ApiError } from "../api-errors.js";
import { classifyRequest } from "../csrf.js";
import { isLoopbackRequestHeaders } from "@project-relay/shared";

export function isRelayV2Enabled(): boolean {
  return process.env.RELAY_V2_ENABLED !== "false";
}

export function assertRelayV2Enabled(): void {
  if (!isRelayV2Enabled()) throw new ApiError("NOT_FOUND", "Relay v2 is disabled.");
}

export function isRelayV2ExecutionEnabled(): boolean {
  return isRelayV2Enabled() && process.env.RELAY_V2_EXECUTION_ENABLED !== "false";
}

export function assertRelayV2ExecutionEnabled(): void {
  if (!isRelayV2ExecutionEnabled()) throw new ApiError("NOT_FOUND", "Relay v2 execution is disabled.");
}

export function requireRelayV2Read(request: NextRequest): void {
  assertRelayV2Enabled();
  const loopback = isLoopbackRequestHeaders({
    host: request.headers.get("host"),
    forwardedFor: request.headers.get("x-forwarded-for"),
    forwardedHost: request.headers.get("x-forwarded-host")
  });
  if (!loopback) throw new ApiError("FORBIDDEN", "Relay v2 only accepts local requests.");
}

export async function requireRelayV2Mutation(request: NextRequest): Promise<void> {
  assertRelayV2Enabled();
  const loopback = isLoopbackRequestHeaders({
    host: request.headers.get("host"),
    forwardedFor: request.headers.get("x-forwarded-for"),
    forwardedHost: request.headers.get("x-forwarded-host")
  });
  if (!loopback) throw new ApiError("FORBIDDEN", "Relay v2 only accepts local requests.");
  const gate = classifyRequest(request);
  if (gate === "cross-origin") throw new ApiError("FORBIDDEN", "Cross-origin requests are not permitted.");
  if (gate !== "ok") throw new ApiError("UNAUTHENTICATED", "Same-origin CSRF validation failed.");
}

export async function getRelayV2Orchestrator(): Promise<RelayV2Orchestrator> {
  assertRelayV2Enabled();
  const { client } = await getRelayV2Database();
  return new RelayV2Orchestrator(client);
}

type RelayV2ExecutionServices = { engine: ExecutionEngine; runtime: ExecutionRuntimeHost };
const executionGlobal = globalThis as unknown as { relayV2ExecutionServices?: Promise<RelayV2ExecutionServices> };

export function getRelayV2ExecutionServices(): Promise<RelayV2ExecutionServices> {
  assertRelayV2ExecutionEnabled();
  executionGlobal.relayV2ExecutionServices ??= (async () => {
    const { client, paths } = await getRelayV2Database();
    const engine = new ExecutionEngine(client, new FakeExecutor(), new ExecutionArtifactStore(paths.artifactsDir));
    return { engine, runtime: new ExecutionRuntimeHost(engine) };
  })();
  return executionGlobal.relayV2ExecutionServices;
}
