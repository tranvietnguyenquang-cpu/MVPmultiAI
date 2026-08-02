import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ExecutionArtifactStore } from "./artifacts.js";

describe("execution artifact store", () => {
  it("redacts, hashes, bounds, and reports truncated full logs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "relay-v2-artifacts-"));
    const sessionId = "11111111-1111-4111-8111-111111111111";
    try {
      const store = new ExecutionArtifactStore(root, 48);
      const truncated = await store.appendLog(sessionId, { output: "token=abcdefghijklmnop and more output that exceeds the cap" });
      const metadata = await store.finalizeLog(sessionId, truncated);
      expect(metadata).toMatchObject({ artifactType: "LOG", byteCount: 48, truncated: true });
      expect(metadata.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(await readFile(path.join(root, metadata.relativePath), "utf8")).not.toContain("abcdefghijklmnop");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
