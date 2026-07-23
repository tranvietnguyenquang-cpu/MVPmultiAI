import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { captureOwnedProcess, terminateOwnedProcessTree } from "./owned-process.js";

const execFileAsync = promisify(execFile);
const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "owned-process.fixture.cjs");

type TreePids = { rootPid: number; childPid: number; grandchildPid: number };

function spawnFixture(role: "root" | "sibling"): ChildProcess {
  return spawn(process.execPath, [fixture, role], {
    stdio: role === "root" ? ["ignore", "pipe", "ignore"] : "ignore",
    windowsHide: true,
  });
}

async function readTree(root: ChildProcess): Promise<TreePids> {
  const [chunk] = await once(root.stdout!, "data");
  return JSON.parse(Buffer.from(chunk).toString("utf8")) as TreePids;
}

async function processExists(pid: number): Promise<boolean> {
  try {
    await execFileAsync("powershell.exe", ["-NoProfile", "-Command", `Get-Process -Id ${pid} -ErrorAction Stop | Out-Null`], {
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (!(await processExists(pid))) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Process ${pid} did not exit after bounded termination.`);
}

describe("owned Windows provider process trees", () => {
  it("terminates only the recorded root tree and leaves an unrelated sibling alive", async () => {
    const root = spawnFixture("root");
    const sibling = spawnFixture("sibling");
    let rootPids: TreePids | undefined;
    let owned: Awaited<ReturnType<typeof captureOwnedProcess>> | undefined;

    try {
      rootPids = await readTree(root);
      expect(rootPids.rootPid).toBe(root.pid);
      expect(rootPids.childPid).not.toBe(rootPids.rootPid);
      expect(rootPids.grandchildPid).not.toBe(rootPids.childPid);
      expect(sibling.pid).toBeDefined();

      owned = await captureOwnedProcess({
        rootPid: rootPids.rootPid,
        agentSessionId: "session",
        providerId: "codex-cli",
        workerId: "worker",
      });
      expect(owned.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      const exited = once(root, "exit");
      expect(await terminateOwnedProcessTree({
        rootPid: owned.rootPid,
        expectedStartIdentity: owned.startedAt,
        agentSessionId: "session",
        reason: "CANCELLED",
      })).toBe("TERMINATED");
      await exited;
      await Promise.all([waitForExit(rootPids.rootPid), waitForExit(rootPids.childPid), waitForExit(rootPids.grandchildPid)]);
      expect(await processExists(sibling.pid!)).toBe(true);
      expect(await terminateOwnedProcessTree({
        rootPid: owned.rootPid,
        expectedStartIdentity: owned.startedAt,
        agentSessionId: "session",
        reason: "CANCELLED",
      })).toBe("ALREADY_EXITED");
    } finally {
      if (owned && rootPids && (await processExists(rootPids.rootPid))) {
        await terminateOwnedProcessTree({
          rootPid: owned.rootPid,
          expectedStartIdentity: owned.startedAt,
          agentSessionId: "session",
          reason: "CANCELLED",
        }).catch(() => undefined);
      }
      sibling.kill();
      if (sibling.pid) await waitForExit(sibling.pid).catch(() => undefined);
    }
  }, 15_000);

  it("refuses a PID with a mismatched start identity and safely handles an already-exited tree", async () => {
    const child = spawnFixture("sibling");
    const owned = await captureOwnedProcess({
      rootPid: child.pid!,
      agentSessionId: "session",
      providerId: "claude-cli",
      workerId: "worker",
    });

    try {
      expect(await terminateOwnedProcessTree({
        rootPid: owned.rootPid,
        expectedStartIdentity: "wrong",
        agentSessionId: "session",
        reason: "ABSOLUTE_TIMEOUT",
      })).toBe("IDENTITY_MISMATCH");
      expect(await processExists(child.pid!)).toBe(true);
      child.kill();
      await waitForExit(child.pid!);
      expect(await terminateOwnedProcessTree({
        rootPid: owned.rootPid,
        expectedStartIdentity: owned.startedAt,
        agentSessionId: "session",
        reason: "ABSOLUTE_TIMEOUT",
      })).toBe("ALREADY_EXITED");
    } finally {
      child.kill();
    }
  }, 15_000);
});
