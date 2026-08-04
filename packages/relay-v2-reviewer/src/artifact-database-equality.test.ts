import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalJson, untruncatedProvenance } from "@project-relay/relay-v2-domain";
import { validateRequiredArtifacts, type ArtifactRecord, type ValidatedReviewEvidencePart } from "./artifact-evidence.js";
import { checkArtifactDatabaseEquality, sha256Hex } from "./review-binding.js";
import { artifactRowProvenance, capturedStreamProvenance, changedFile, changedFilesArtifact, emptyStreamCapture, finalGitArtifact, patchArtifact, verificationArtifact } from "./evidence-test-fixtures.js";

/**
 * The cryptographic equality edge between the two stores.
 *
 * Each test mutates exactly ONE store and proves the review is blocked. That
 * is the property a self-hash inside mutable database JSON cannot provide: an
 * actor who can rewrite that JSON can also recompute the hash inside it, so
 * the only thing that catches the edit is a comparison against independently
 * byte-validated artifact content.
 */

const SESSION_ID = "11111111-1111-1111-1111-111111111111";
const BASELINE_HEAD = "a".repeat(40);
const FINAL_HEAD = "b".repeat(40);
const CHANGED_PATH = "src/a.ts";

/** A persisted GitEvidence whose self-referential evidenceHash is correct for its own content. */
function gitEvidence(overrides: Record<string, unknown> = {}) {
  const withoutHash = {
    repositoryRoot: "C:/fixture-repo", branch: "relay-v2", head: FINAL_HEAD, dirty: true,
    status: [{
      path: CHANGED_PATH, indexStatus: "M", worktreeStatus: " ", staged: true, unstaged: false, untracked: false,
      sensitive: false, contentSha256: "2".repeat(64), byteCount: 10, binary: false
    }],
    stagedCount: 1, unstagedCount: 0, untrackedCount: 0,
    patchPreview: `diff --git a/${CHANGED_PATH} b/${CHANGED_PATH}\n`,
    patchSha256: sha256Hex(`diff --git a/${CHANGED_PATH} b/${CHANGED_PATH}\n`),
    patchTruncated: false, patchProvenance: untruncatedProvenance(`diff --git a/${CHANGED_PATH} b/${CHANGED_PATH}\n`),
    patchOmittedForSensitivePaths: false,
    ...overrides
  };
  return { ...withoutHash, capturedAt: "2026-08-05T00:00:00.000Z", evidenceHash: sha256Hex(canonicalJson(withoutHash)) };
}

function baselineEvidenceJson(): string {
  const withoutHash = {
    repositoryRoot: "C:/fixture-repo", branch: "relay-v2", head: BASELINE_HEAD, dirty: false,
    status: [], stagedCount: 0, unstagedCount: 0, untrackedCount: 0,
    patchPreview: "", patchSha256: sha256Hex(""), patchTruncated: false,
    patchProvenance: untruncatedProvenance(""), patchOmittedForSensitivePaths: false
  };
  return canonicalJson({ ...withoutHash, capturedAt: "2026-08-05T00:00:00.000Z", evidenceHash: sha256Hex(canonicalJson(withoutHash)) });
}

function finalEvidenceJson(evidenceOverrides: Record<string, unknown> = {}, deltaOverrides: Record<string, unknown> = {}): string {
  const evidence = gitEvidence(evidenceOverrides);
  const delta = {
    baselineHash: "9".repeat(64), finalHash: evidence.evidenceHash,
    changedFiles: [{ path: CHANGED_PATH, baselineSha256: "1".repeat(64), finalSha256: "2".repeat(64), preExisting: true, binary: false }],
    headChanged: false, branchChanged: false, preExistingChangesDestroyed: [], preExistingChangesHidden: [],
    unaccountedPreExistingPaths: [], stashChanged: false, forbiddenGitMutationSuspected: false,
    ...deltaOverrides
  };
  return canonicalJson({ evidence, delta });
}

function verificationResult(overrides: Record<string, unknown> = {}) {
  const withoutHash = {
    operation: "NPM_TEST", displayCommand: "npm test", passed: true, exitCode: 0, timedOut: false, cancelled: false,
    summary: "npm test passed.",
    stdoutPreview: "1 passed", stdoutTruncated: false, stdoutProvenance: untruncatedProvenance("1 passed"),
    stderrPreview: "", stderrTruncated: false, stderrProvenance: untruncatedProvenance(""),
    runnerOutputTruncated: false, runnerStdoutBytes: 8, runnerStderrBytes: 0,
    stdoutCapture: capturedStreamProvenance("stdout", "1 passed"), stderrCapture: emptyStreamCapture("stderr"),
    startedAt: "2026-08-05T00:00:00.000Z", finishedAt: "2026-08-05T00:00:01.000Z",
    ...overrides
  };
  return { ...withoutHash, resultHash: sha256Hex(canonicalJson(withoutHash)) };
}

/** The artifact-side rendering of the same evidence, derived from the same values as the database side. */
function artifactBodies(): Record<string, string> {
  const files = [changedFile(CHANGED_PATH, { status: "modified", baselineSha256: "1".repeat(64), finalSha256: "2".repeat(64) })];
  const evidence = gitEvidence();
  return {
    FINAL_GIT: canonicalJson(finalGitArtifact(files, {
      branch: evidence.branch, head: evidence.head, clean: false, captureEvidenceHash: evidence.evidenceHash
    })),
    CHANGED_FILES: canonicalJson(changedFilesArtifact(files)),
    PATCH: canonicalJson(patchArtifact([CHANGED_PATH], {
      baselineHead: BASELINE_HEAD, finalHead: FINAL_HEAD, unifiedDiff: evidence.patchPreview
    })),
    VERIFICATION: canonicalJson(verificationArtifact([{
      operation: "NPM_TEST", displayCommand: "npm test", status: "PASSED", exitCode: 0, summary: "npm test passed.",
      stdout: "1 passed", stdoutTruncation: untruncatedProvenance("1 passed"),
      stderr: "", stderrTruncation: untruncatedProvenance(""),
      runnerOutputTruncated: false, runnerStdoutBytes: 8, runnerStderrBytes: 0,
      stdoutCapture: capturedStreamProvenance("stdout", "1 passed"), stderrCapture: emptyStreamCapture("stderr"),
      startedAt: "2026-08-05T00:00:00.000Z", finishedAt: "2026-08-05T00:00:01.000Z",
      resultHash: verificationResult().resultHash
    }])),
    LOG: '{"type":"output","message":"started","payload":{}}\n'
  };
}

describe("artifact/database canonical semantic equality", () => {
  let root: string;
  let bodies: Record<string, string>;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "relay-v2-cross-store-"));
    bodies = artifactBodies();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const FILENAMES: Record<string, string> = {
    FINAL_GIT: "final-git.json", CHANGED_FILES: "changed-files.json",
    PATCH: "final-patch.json", VERIFICATION: "verification-results.json", LOG: "log.ndjson"
  };

  async function writeArtifacts(): Promise<ArtifactRecord[]> {
    const records: ArtifactRecord[] = [];
    for (const [artifactType, content] of Object.entries(bodies)) {
      const relativePath = FILENAMES[artifactType]!;
      const full = path.join(root, relativePath);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, content, "utf8");
      records.push({
        id: `${artifactType}-id`, sessionId: SESSION_ID, artifactType, relativePath,
        sha256: createHash("sha256").update(content).digest("hex"), byteCount: Buffer.byteLength(content, "utf8"),
        truncated: false, ...artifactRowProvenance(content)
      });
    }
    return records;
  }

  async function validatedParts(): Promise<ValidatedReviewEvidencePart[]> {
    const result = await validateRequiredArtifacts(root, SESSION_ID, await writeArtifacts());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    return result.parts;
  }

  /** Replaces one artifact's bytes on disk and returns a row whose metadata still matches the new bytes. */
  async function rewriteArtifact(records: ArtifactRecord[], artifactType: string, content: string): Promise<ArtifactRecord[]> {
    await writeFile(path.join(root, FILENAMES[artifactType]!), content, "utf8");
    return records.map(record => record.artifactType === artifactType
      ? { ...record, sha256: createHash("sha256").update(content).digest("hex"), byteCount: Buffer.byteLength(content, "utf8"), ...artifactRowProvenance(content) }
      : record);
  }

  it("accepts the untouched, mutually consistent pair", () => {
    return validatedParts().then(parts => {
      expect(checkArtifactDatabaseEquality(parts, baselineEvidenceJson(), finalEvidenceJson(), canonicalJson([verificationResult()]))).toEqual({ ok: true });
    });
  });

  describe("database JSON replaced while the artifact bytes stay untouched", () => {
    it("rejects divergent Git evidence even though the replacement is internally valid with a correctly recomputed self-hash", async () => {
      const parts = await validatedParts();
      // Internally valid, self-hash correct -- and describing a different branch.
      const tampered = finalEvidenceJson({ branch: "attacker-branch" });
      const parsed = JSON.parse(tampered) as { evidence: { evidenceHash: string; branch: string } };
      expect(parsed.evidence.branch).toBe("attacker-branch");
      expect(parsed.evidence.evidenceHash).toBe(sha256Hex(canonicalJson(Object.fromEntries(
        Object.entries(parsed.evidence).filter(([key]) => key !== "capturedAt" && key !== "evidenceHash")
      ))));
      const result = checkArtifactDatabaseEquality(parts, baselineEvidenceJson(), tampered, canonicalJson([verificationResult()]));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/FINAL_GIT artifact and the persisted Git evidence/);
    });

    it("rejects a divergent changed-file set", async () => {
      const parts = await validatedParts();
      const tampered = finalEvidenceJson({}, {
        changedFiles: [{ path: "src/other.ts", baselineSha256: "1".repeat(64), finalSha256: "2".repeat(64), preExisting: true, binary: false }]
      });
      const result = checkArtifactDatabaseEquality(parts, baselineEvidenceJson(), tampered, canonicalJson([verificationResult()]));
      expect(result.ok).toBe(false);
    });

    it("rejects a divergent diff", async () => {
      const parts = await validatedParts();
      const tampered = finalEvidenceJson({ patchPreview: `diff --git a/${CHANGED_PATH} b/${CHANGED_PATH}\n+malicious\n` });
      const result = checkArtifactDatabaseEquality(parts, baselineEvidenceJson(), tampered, canonicalJson([verificationResult()]));
      expect(result.ok).toBe(false);
    });

    it("rejects divergent verification results, even with each entry's own resultHash recomputed correctly", async () => {
      const parts = await validatedParts();
      const tampered = verificationResult({ passed: true, exitCode: 0, summary: "npm test passed.", stdoutPreview: "999 passed" });
      expect(tampered.resultHash).toBe(sha256Hex(canonicalJson(Object.fromEntries(
        Object.entries(tampered).filter(([key]) => key !== "resultHash")
      ))));
      const result = checkArtifactDatabaseEquality(parts, baselineEvidenceJson(), finalEvidenceJson(), canonicalJson([tampered]));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/VERIFICATION artifact and the persisted verification results/);
    });

    it("rejects a claimed-passing verification result whose artifact says it failed", async () => {
      const parts = await validatedParts();
      const failed = verificationResult({ passed: false, exitCode: 1, summary: "npm test failed." });
      const result = checkArtifactDatabaseEquality(parts, baselineEvidenceJson(), finalEvidenceJson(), canonicalJson([failed]));
      expect(result.ok).toBe(false);
    });

    it("rejects emptied Git evidence while Git artifacts still exist", async () => {
      const parts = await validatedParts();
      const result = checkArtifactDatabaseEquality(parts, baselineEvidenceJson(), "{}", canonicalJson([verificationResult()]));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/persisted Git evidence is empty/);
    });
  });

  describe("artifact bytes replaced while the database JSON stays untouched", () => {
    it("rejects at byte level when the bytes change but the row's metadata is left alone", async () => {
      const records = await writeArtifacts();
      await writeFile(path.join(root, FILENAMES.FINAL_GIT!), canonicalJson(finalGitArtifact([], { branch: "attacker-branch" })), "utf8");
      const result = await validateRequiredArtifacts(root, SESSION_ID, records);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/byte count|content hash/);
    });

    it("rejects when the bytes change AND the row's hash and byte count are recomputed to match them", async () => {
      const records = await writeArtifacts();
      const forged = canonicalJson(finalGitArtifact([], { branch: "attacker-branch", clean: true }));
      const updated = await rewriteArtifact(records, "FINAL_GIT", forged);
      // Byte validation now passes -- the row and the file agree with each other.
      const validated = await validateRequiredArtifacts(root, SESSION_ID, updated);
      expect(validated.ok).toBe(true);
      if (!validated.ok) return;
      // ...and the cross-store comparison is what catches it.
      const result = checkArtifactDatabaseEquality(validated.parts, baselineEvidenceJson(), finalEvidenceJson(), canonicalJson([verificationResult()]));
      expect(result.ok).toBe(false);
    });

    it("rejects a forged patch artifact whose row metadata was fully rebuilt around it", async () => {
      const records = await writeArtifacts();
      const forged = canonicalJson(patchArtifact([CHANGED_PATH], {
        baselineHead: BASELINE_HEAD, finalHead: FINAL_HEAD, unifiedDiff: "diff --git a/src/a.ts b/src/a.ts\n+forged\n"
      }));
      const validated = await validateRequiredArtifacts(root, SESSION_ID, await rewriteArtifact(records, "PATCH", forged));
      expect(validated.ok).toBe(true);
      if (!validated.ok) return;
      expect(checkArtifactDatabaseEquality(validated.parts, baselineEvidenceJson(), finalEvidenceJson(), canonicalJson([verificationResult()])).ok).toBe(false);
    });

    it("rejects a forged verification artifact whose row metadata was fully rebuilt around it", async () => {
      const records = await writeArtifacts();
      const forged = canonicalJson(verificationArtifact([{
        operation: "NPM_TEST", displayCommand: "npm test", status: "PASSED", exitCode: 0, summary: "npm test passed.",
        stdout: "forged output", stdoutTruncation: untruncatedProvenance("forged output"),
        stderr: "", stderrTruncation: untruncatedProvenance(""),
        runnerOutputTruncated: false, runnerStdoutBytes: 13, runnerStderrBytes: 0,
        stdoutCapture: capturedStreamProvenance("stdout", "forged output"), stderrCapture: emptyStreamCapture("stderr"),
        startedAt: "2026-08-05T00:00:00.000Z", finishedAt: "2026-08-05T00:00:01.000Z", resultHash: "7".repeat(64)
      }]));
      const validated = await validateRequiredArtifacts(root, SESSION_ID, await rewriteArtifact(records, "VERIFICATION", forged));
      expect(validated.ok).toBe(true);
      if (!validated.ok) return;
      expect(checkArtifactDatabaseEquality(validated.parts, baselineEvidenceJson(), finalEvidenceJson(), canonicalJson([verificationResult()])).ok).toBe(false);
    });

    it("rejects a byteCount claim that does not match the bytes on disk", async () => {
      const records = (await writeArtifacts()).map(record => record.artifactType === "FINAL_GIT" ? { ...record, byteCount: record.byteCount + 1 } : record);
      const result = await validateRequiredArtifacts(root, SESSION_ID, records);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/byte count/);
    });

    it("rejects a sha256 claim that does not match the bytes on disk", async () => {
      const records = (await writeArtifacts()).map(record => record.artifactType === "FINAL_GIT" ? { ...record, sha256: "f".repeat(64) } : record);
      const result = await validateRequiredArtifacts(root, SESSION_ID, records);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/content hash/);
    });

    it("leaves the artifact file itself untouched throughout -- the checks never write", async () => {
      const parts = await validatedParts();
      const before = await readFile(path.join(root, FILENAMES.FINAL_GIT!), "utf8");
      checkArtifactDatabaseEquality(parts, baselineEvidenceJson(), finalEvidenceJson(), canonicalJson([verificationResult()]));
      expect(await readFile(path.join(root, FILENAMES.FINAL_GIT!), "utf8")).toBe(before);
    });
  });
});
