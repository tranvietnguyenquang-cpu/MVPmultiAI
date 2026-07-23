import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type OwnedProcess = {
  rootPid: number;
  startedAt: string;
  agentSessionId: string;
  providerId: string;
  workerId: string;
};
export type TerminationReason = "CANCELLED" | "INACTIVITY_TIMEOUT" | "ABSOLUTE_TIMEOUT" | "OWNERSHIP_FAILURE" | "WORKER_RECOVERY";
export type TerminationResult = "TERMINATED" | "ALREADY_EXITED" | "IDENTITY_MISMATCH";

async function startIdentity(pid: number): Promise<string | undefined> {
  if (process.platform !== "win32") return undefined;
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-Command", `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('O')`],
      { windowsHide: true },
    );
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function waitForExit(pid: number): Promise<TerminationResult> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!(await startIdentity(pid))) return "TERMINATED";
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Owned provider process did not exit after bounded termination.");
}

export async function captureOwnedProcess(input: Omit<OwnedProcess, "startedAt">): Promise<OwnedProcess> {
  const startedAt = await startIdentity(input.rootPid);
  if (!startedAt) throw new Error("Owned provider process exited before ownership could be recorded.");
  return { ...input, startedAt };
}

export async function terminateOwnedProcessTree(input: {
  rootPid: number;
  expectedStartIdentity: string;
  agentSessionId: string;
  reason: TerminationReason;
}): Promise<TerminationResult> {
  const current = await startIdentity(input.rootPid);
  if (!current) return "ALREADY_EXITED";
  if (current !== input.expectedStartIdentity) return "IDENTITY_MISMATCH";
  await execFileAsync("taskkill", ["/pid", String(input.rootPid), "/t", "/f"], { windowsHide: true }).catch(() => undefined);
  return waitForExit(input.rootPid);
}

/** Safe only for a child process that was just spawned by this worker and has not been released to any caller. */
export async function terminateNewlySpawnedProcessTree(rootPid: number): Promise<TerminationResult> {
  if (!(await startIdentity(rootPid))) return "ALREADY_EXITED";
  await execFileAsync("taskkill", ["/pid", String(rootPid), "/t", "/f"], { windowsHide: true }).catch(() => undefined);
  return waitForExit(rootPid);
}
