import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateExecutionArtifact, type ArtifactRecord } from "./artifact-evidence.js";
import { artifactRowProvenance } from "./evidence-test-fixtures.js";

const SESSION_ID = "11111111-1111-1111-1111-111111111111";



describe("validateExecutionArtifact", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "relay-v2-artifact-evidence-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function writeReal(relativePath: string, content: string): Promise<ArtifactRecord> {
    const full = path.join(root, relativePath);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content);
    return {
      id: "artifact-1", sessionId: SESSION_ID, artifactType: "FINAL_GIT", relativePath,
      sha256: createHash("sha256").update(content).digest("hex"), byteCount: Buffer.byteLength(content), truncated: false,
      ...artifactRowProvenance(content)
    };
  }

  it("accepts a real artifact whose stored hash/byte count match its actual bytes", async () => {
    const artifact = await writeReal("executions/session/final-git.json", "hello world");
    const result = await validateExecutionArtifact(root, SESSION_ID, new Set([artifact.id]), artifact);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.content.toString("utf8")).toBe("hello world");
  });

  it("rejects an artifact whose sessionId does not match the execution session under review", async () => {
    const artifact = await writeReal("executions/session/final-git.json", "hello world");
    const wrongSession = { ...artifact, sessionId: "22222222-2222-2222-2222-222222222222" };
    const result = await validateExecutionArtifact(root, SESSION_ID, new Set([artifact.id]), wrongSession);
    expect(result.ok).toBe(false);
  });

  it("rejects an artifact not in the bound artifact set", async () => {
    const artifact = await writeReal("executions/session/final-git.json", "hello world");
    const result = await validateExecutionArtifact(root, SESSION_ID, new Set(["some-other-id"]), artifact);
    expect(result.ok).toBe(false);
  });

  it("rejects a hash mismatch", async () => {
    const artifact = await writeReal("executions/session/final-git.json", "hello world");
    const tampered = { ...artifact, sha256: "f".repeat(64) };
    const result = await validateExecutionArtifact(root, SESSION_ID, new Set([tampered.id]), tampered);
    expect(result.ok).toBe(false);
  });

  it("rejects a byte-count mismatch", async () => {
    const artifact = await writeReal("executions/session/final-git.json", "hello world");
    const tampered = { ...artifact, byteCount: artifact.byteCount + 1 };
    const result = await validateExecutionArtifact(root, SESSION_ID, new Set([tampered.id]), tampered);
    expect(result.ok).toBe(false);
  });

  it("rejects a relativePath that attempts absolute-path injection", async () => {
    const artifact: ArtifactRecord = {
      id: "artifact-2", sessionId: SESSION_ID, artifactType: "FINAL_GIT",
      relativePath: path.resolve(root, "../outside.json"), sha256: "a".repeat(64), byteCount: 0, truncated: false, ...artifactRowProvenance("")
    };
    const result = await validateExecutionArtifact(root, SESSION_ID, new Set([artifact.id]), artifact);
    expect(result.ok).toBe(false);
  });

  it("rejects a relativePath with a '..' traversal segment", async () => {
    const artifact: ArtifactRecord = {
      id: "artifact-3", sessionId: SESSION_ID, artifactType: "FINAL_GIT",
      relativePath: "executions/../../outside.json", sha256: "a".repeat(64), byteCount: 0, truncated: false, ...artifactRowProvenance("")
    };
    const result = await validateExecutionArtifact(root, SESSION_ID, new Set([artifact.id]), artifact);
    expect(result.ok).toBe(false);
  });

  it("rejects a symlink that escapes the artifacts root", async () => {
    const outside = await mkdtemp(path.join(tmpdir(), "relay-v2-artifact-outside-"));
    try {
      const outsideFile = path.join(outside, "secret.json");
      await writeFile(outsideFile, "secret content");
      const linkRelative = "executions/session/escape.json";
      const linkPath = path.join(root, linkRelative);
      await mkdir(path.dirname(linkPath), { recursive: true });
      try {
        await symlink(outsideFile, linkPath, "file");
      } catch {
        // Creating symlinks may require elevated privileges on some Windows
        // configurations; skip this specific escape vector if unsupported
        // rather than failing the whole suite on an environment limitation.
        return;
      }
      const artifact: ArtifactRecord = {
        id: "artifact-4", sessionId: SESSION_ID, artifactType: "FINAL_GIT", relativePath: linkRelative,
        sha256: createHash("sha256").update("secret content").digest("hex"), byteCount: "secret content".length, truncated: false, ...artifactRowProvenance("secret content")
      };
      const result = await validateExecutionArtifact(root, SESSION_ID, new Set([artifact.id]), artifact);
      expect(result.ok).toBe(false);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects a directory where a file is expected", async () => {
    const relativePath = "executions/session/a-directory";
    await mkdir(path.join(root, relativePath), { recursive: true });
    const artifact: ArtifactRecord = { id: "artifact-5", sessionId: SESSION_ID, artifactType: "FINAL_GIT", relativePath, sha256: "a".repeat(64), byteCount: 0, truncated: false, ...artifactRowProvenance("") };
    const result = await validateExecutionArtifact(root, SESSION_ID, new Set([artifact.id]), artifact);
    expect(result.ok).toBe(false);
  });

  it("rejects a missing file", async () => {
    const artifact: ArtifactRecord = { id: "artifact-6", sessionId: SESSION_ID, artifactType: "FINAL_GIT", relativePath: "executions/session/missing.json", sha256: "a".repeat(64), byteCount: 0, truncated: false, ...artifactRowProvenance("") };
    const result = await validateExecutionArtifact(root, SESSION_ID, new Set([artifact.id]), artifact);
    expect(result.ok).toBe(false);
  });

  it("accepts binary/NUL content byte-for-byte (byte validation is content-agnostic; redaction/UTF-8 policy is enforced by the review-material layer, not here)", async () => {
    const relativePath = "executions/session/binary.bin";
    const full = path.join(root, relativePath);
    await mkdir(path.dirname(full), { recursive: true });
    const content = Buffer.from([0, 1, 2, 0xff, 0xfe, 0]);
    await writeFile(full, content);
    const artifact: ArtifactRecord = {
      id: "artifact-7", sessionId: SESSION_ID, artifactType: "FINAL_GIT", relativePath,
      sha256: createHash("sha256").update(content).digest("hex"), byteCount: content.byteLength, truncated: false,
      schemaVersion: "evidence-artifact-v1", fullContentSha256: createHash("sha256").update(content).digest("hex"),
      originalByteCount: content.byteLength, omittedByteCount: 0, truncationMethod: "NONE", provenanceJson: "{}"
    };
    const result = await validateExecutionArtifact(root, SESSION_ID, new Set([artifact.id]), artifact);
    expect(result.ok).toBe(true);
  });
});
