import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecutionEngine } from "./engine.js";
import { ExecutionRuntimeHost } from "./runtime-host.js";

async function waitFor(assertion: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!assertion() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 2));
  if (!assertion()) throw new Error("Timed out waiting for runtime-host condition.");
}

describe("ExecutionRuntimeHost error boundary", () => {
  const hosts: ExecutionRuntimeHost[] = [];

  afterEach(async () => {
    await Promise.all(hosts.map(host => host.stop()));
    hosts.length = 0;
  });

  it("redacts an unexpected owned-session failure, keeps polling, and processes later work", async () => {
    const diagnostics = vi.fn();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const claims = [
      { sessionId: "failed-session", leaseToken: "lease-1" },
      { sessionId: "later-session", leaseToken: "lease-2" },
      null
    ];
    const runClaimed = vi.fn()
      .mockRejectedValueOnce(new Error("runtime failed token=supersecretvalue\nunsafe stack-like detail"))
      .mockResolvedValueOnce(undefined);
    const engine = {
      executor: { describe: () => ({ id: "fake", displayName: "Fake Executor" }) },
      recoverStaleSessions: vi.fn().mockResolvedValue(0),
      claimNext: vi.fn().mockImplementation(async () => claims.shift() ?? null),
      runClaimed,
      cancelSession: vi.fn().mockResolvedValue({ alreadyTerminal: true })
    } as unknown as ExecutionEngine;
    const host = new ExecutionRuntimeHost(engine, { pollMs: 2, recoveryEvery: 2, onDiagnostic: diagnostics });
    hosts.push(host);

    host.start();
    await waitFor(() => runClaimed.mock.calls.length === 2);
    await new Promise(resolve => setTimeout(resolve, 5));

    expect(unhandled).not.toHaveBeenCalled();
    expect(runClaimed).toHaveBeenNthCalledWith(1, "failed-session", "lease-1");
    expect(runClaimed).toHaveBeenNthCalledWith(2, "later-session", "lease-2");
    expect(diagnostics).toHaveBeenCalledTimes(1);
    expect(diagnostics.mock.calls[0]?.[0]).toMatchObject({
      code: "RUNTIME_TICK_FAILED",
      level: "ERROR",
      sessionId: "failed-session"
    });
    const message = String(diagnostics.mock.calls[0]?.[0]?.message);
    expect(message).toContain("[REDACTED]");
    expect(message).not.toContain("supersecretvalue");
    expect(message).not.toContain("at ExecutionRuntimeHost");
    expect(host.status().lastDiagnostic).toEqual(diagnostics.mock.calls[0]?.[0]);

    await host.stop();
    expect(host.status().running).toBe(false);
    process.off("unhandledRejection", unhandled);
  });
});
