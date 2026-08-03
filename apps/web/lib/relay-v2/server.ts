import type { NextRequest } from "next/server";
import { getRelayV2Database } from "@project-relay/relay-v2-persistence";
import { RelayV2Orchestrator } from "@project-relay/relay-v2-orchestrator";
import { CodexCliExecutor, ExecutionArtifactStore, ExecutionEngine, ExecutionRuntimeHost, FakeExecutor } from "@project-relay/relay-v2-execution";
import { FakeReviewer, ReviewEngine, ReviewRuntimeHost } from "@project-relay/relay-v2-reviewer";
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
    const codex = process.env.PROJECT_RELAY_TEST_MODE === "true" && process.env.RELAY_V2_CODEX_TEST_DOUBLE === "true"
      ? (await import("./codex-test-double.js")).createBrowserCodexTestDouble()
      : new CodexCliExecutor();
    const engine = new ExecutionEngine(client, [new FakeExecutor(), codex], new ExecutionArtifactStore(paths.artifactsDir));
    return { engine, runtime: new ExecutionRuntimeHost(engine) };
  })();
  return executionGlobal.relayV2ExecutionServices;
}

type RelayV2ReviewServices = { engine: ReviewEngine; runtime: ReviewRuntimeHost };
const reviewGlobal = globalThis as unknown as { relayV2ReviewServices?: Promise<RelayV2ReviewServices> };

export function getRelayV2ReviewServices(): Promise<RelayV2ReviewServices> {
  assertRelayV2ExecutionEnabled();
  reviewGlobal.relayV2ReviewServices ??= (async () => {
    const { client } = await getRelayV2Database();
    // FakeExecutor sessions are only reviewable in this explicit automated-test diagnostic mode,
    // never in a normal local or production runtime.
    const allowFakeExecutorDiagnosticReviews = process.env.PROJECT_RELAY_TEST_MODE === "true";
    // A separately-gated diagnostic path (mirrors createBrowserCodexTestDouble's gate)
    // that lets FakeReviewer review a codex-cli test-double session in the disposable
    // Playwright browser-test environment only. Never AUTHORITATIVE, never on elsewhere.
    const allowCodexTestDoubleDiagnosticReviews = process.env.PROJECT_RELAY_TEST_MODE === "true"
      && process.env.RELAY_V2_FAKE_REVIEWER_DIAGNOSTIC === "true"
      && Boolean(process.env.RELAY_V2_DATA_DIR?.includes("playwright-v2"));
    const engine = new ReviewEngine(client, [new FakeReviewer()], { allowFakeExecutorDiagnosticReviews, allowCodexTestDoubleDiagnosticReviews });
    return { engine, runtime: new ReviewRuntimeHost(engine) };
  })();
  return reviewGlobal.relayV2ReviewServices;
}
