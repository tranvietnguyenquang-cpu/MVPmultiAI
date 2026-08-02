import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { redactSecrets, validateWorkspace } from "./index.js";

describe("dependency-free local safety utilities", () => {
  it("validates an absolute Git repository root", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "relay-local-safety-"));
    await mkdir(path.join(workspace, ".git"));
    await expect(validateWorkspace(workspace)).resolves.toBe(await realpath(workspace));
    await rm(workspace, { recursive: true, force: true });
  });

  it("redacts secrets without execution-package dependencies", () => {
    expect(redactSecrets("Authorization: Bearer abcdefghijklmnopqrstuvwxyz api_key=supersecretvalue123")).not.toContain("supersecretvalue123");
  });
});
