import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ExecutionArtifactStore } from "./artifacts.js";

describe("execution artifact store", () => {
  it("redacts, hashes, and omits a whole record rather than storing a fragment of one", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "relay-v2-artifacts-"));
    const sessionId = "11111111-1111-4111-8111-111111111111";
    try {
      const store = new ExecutionArtifactStore(root, 48);
      const truncated = await store.appendLog(sessionId, { type: "output", message: "token=abcdefghijklmnop and more output that exceeds the cap", payload: {} });
      const metadata = await store.finalizeLog(sessionId, truncated);
      // The record did not fit, so NONE of it was written: a half-written JSON
      // object is not a log record, and a consumer would have to either reject
      // the whole log or show a reviewer a fragment of an event as if it were
      // the event.
      expect(metadata).toMatchObject({ artifactType: "LOG", byteCount: 0, truncated: true });
      expect(metadata.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(await readFile(path.join(root, metadata.relativePath), "utf8")).toBe("");
      const provenance = JSON.parse(metadata.provenanceJson) as { recordCountOriginal: number; recordCountIncluded: number; omittedRawByteCount: number; captureCompleteness: string };
      expect(provenance).toMatchObject({ recordCountOriginal: 1, recordCountIncluded: 0, captureCompleteness: "TRUNCATED_KNOWN" });
      expect(provenance.omittedRawByteCount).toBeGreaterThan(0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("stores every complete record that fits and reports truthful record counts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "relay-v2-artifacts-"));
    const sessionId = "11111111-1111-4111-8111-111111111112";
    try {
      const store = new ExecutionArtifactStore(root, 5 * 1024 * 1024);
      await store.appendLog(sessionId, { type: "output", message: "one", payload: {} });
      await store.appendLog(sessionId, { type: "output", message: "two", payload: {} });
      const metadata = await store.finalizeLog(sessionId);
      const stored = await readFile(path.join(root, metadata.relativePath), "utf8");
      expect(stored.endsWith("\n")).toBe(true);
      expect(stored.slice(0, -1).split("\n")).toHaveLength(2);
      expect(JSON.parse(metadata.provenanceJson)).toMatchObject({
        recordCountOriginal: 2, recordCountIncluded: 2, producerTruncated: false,
        omittedRawByteCount: 0, captureCompleteness: "COMPLETE"
      });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
