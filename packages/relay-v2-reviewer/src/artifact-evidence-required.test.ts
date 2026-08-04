import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalJson } from "@project-relay/relay-v2-domain";
import {
  assertAuthoritativeLogProvenance, assertProducerTruncationPolicy, checkConditionalEvidenceRequirements,
  validateRequiredArtifacts, type ArtifactRecord
} from "./artifact-evidence.js";
import {
  artifactRowProvenance, changedFile, changedFilesArtifact, completeLogProvenance, finalGitArtifact, patchArtifact,
  truncatedProducerProvenance, verificationArtifact
} from "./evidence-test-fixtures.js";

const SESSION_ID = "11111111-1111-1111-1111-111111111111";
const LOG_LINE = '{"type":"output","message":"started","payload":{}}\n';

describe("validateRequiredArtifacts", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "relay-v2-artifact-evidence-required-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function realArtifact(artifactType: string, relativePath: string, content: string): Promise<ArtifactRecord> {
    const full = path.join(root, relativePath);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content);
    return {
      id: `${artifactType}-id`, sessionId: SESSION_ID, artifactType, relativePath,
      sha256: createHash("sha256").update(content).digest("hex"), byteCount: Buffer.byteLength(content),
      truncated: false, ...artifactRowProvenance(content),
      // A LOG row carries the producer's own provenance verbatim, exactly as
      // ExecutionArtifactStore.finalizeLog writes it.
      ...(artifactType === "LOG" ? { provenanceJson: canonicalJson(completeLogProvenance(content)) } : {})
    };
  }

  /** A complete, mutually consistent artifact set for a run that changed `paths`. */
  async function evidenceSet(paths: readonly string[]): Promise<ArtifactRecord[]> {
    const files = paths.map(entry => changedFile(entry));
    return Promise.all([
      realArtifact("LOG", "log.ndjson", LOG_LINE),
      realArtifact("FINAL_GIT", "final-git.json", canonicalJson(finalGitArtifact(files))),
      realArtifact("CHANGED_FILES", "changed-files.json", canonicalJson(changedFilesArtifact(files))),
      realArtifact("PATCH", "final-patch.json", canonicalJson(patchArtifact(paths))),
      realArtifact("VERIFICATION", "verification-results.json", canonicalJson(verificationArtifact()))
    ]);
  }

  const without = (artifacts: ArtifactRecord[], type: string) => artifacts.filter(artifact => artifact.artifactType !== type);

  it("passes when every required artifact type is present, byte-valid, and schema-valid", async () => {
    const result = await validateRequiredArtifacts(root, SESSION_ID, await evidenceSet(["src/a.ts"]));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.parts.map(part => part.category).sort()).toEqual(["CHANGED_FILES", "FINAL_GIT", "LOG", "PATCH", "VERIFICATION"]);
  });

  it("blocks when a required artifact type (e.g. execution LOG) is missing entirely", async () => {
    const result = await validateRequiredArtifacts(root, SESSION_ID, without(await evidenceSet(["src/a.ts"]), "LOG"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/LOG/);
  });

  it("blocks when any one artifact fails byte validation, even if the others are fine", async () => {
    const artifacts = (await evidenceSet(["src/a.ts"])).map(artifact => artifact.artifactType === "FINAL_GIT" ? { ...artifact, sha256: "f".repeat(64) } : artifact);
    expect((await validateRequiredArtifacts(root, SESSION_ID, artifacts)).ok).toBe(false);
  });

  it("rejects an artifact whose bytes are byte-valid but not schema-valid for its category", async () => {
    const artifacts = without(await evidenceSet(["src/a.ts"]), "FINAL_GIT");
    const broken = await realArtifact("FINAL_GIT", "broken-git.json", canonicalJson({ schemaVersion: "evidence-artifact-v1", artifactType: "FINAL_GIT", unexpected: true }));
    const result = await validateRequiredArtifacts(root, SESSION_ID, [...artifacts, broken]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/strict FINAL_GIT artifact schema/);
  });

  it("rejects an artifact declaring a schema version this build does not support", async () => {
    const artifacts = without(await evidenceSet(["src/a.ts"]), "FINAL_GIT");
    const body = canonicalJson({ ...finalGitArtifact([]), schemaVersion: "evidence-artifact-v99" });
    const future = await realArtifact("FINAL_GIT", "future-git.json", body);
    const result = await validateRequiredArtifacts(root, SESSION_ID, [...artifacts, { ...future, schemaVersion: "evidence-artifact-v99" }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/does not support/);
  });

  it("rejects an artifact whose bytes are not valid UTF-8", async () => {
    const relativePath = "invalid-utf8.json";
    const full = path.join(root, relativePath);
    await mkdir(path.dirname(full), { recursive: true });
    const content = Buffer.from([0x7b, 0xff, 0xfe, 0x7d]);
    await writeFile(full, content);
    const sha256 = createHash("sha256").update(content).digest("hex");
    const broken: ArtifactRecord = {
      id: "broken-utf8", sessionId: SESSION_ID, artifactType: "FINAL_GIT", relativePath,
      sha256, byteCount: content.byteLength, truncated: false,
      schemaVersion: "evidence-artifact-v1", fullContentSha256: sha256,
      originalByteCount: content.byteLength, omittedByteCount: 0, truncationMethod: "NONE", provenanceJson: "{}"
    };
    const result = await validateRequiredArtifacts(root, SESSION_ID, [...without(await evidenceSet([]), "FINAL_GIT"), broken]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not valid UTF-8/);
  });

  it("returns the LOG artifact's exact validated bytes and its producer provenance together, never a second independent read", async () => {
    const result = await validateRequiredArtifacts(root, SESSION_ID, await evidenceSet([]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.log?.validatedIncludedBytes.toString("utf8")).toBe(LOG_LINE);
    expect(result.log?.validatedText).toBe(LOG_LINE);
    // The provenance the row carried, not a reconstruction from its columns.
    expect(result.log?.logProvenance?.captureCompleteness).toBe("COMPLETE");
    expect(result.log?.parsedRecords).toHaveLength(1);
  });

  it("returns a null LOG part when the session has no LOG artifact at all", async () => {
    const result = await validateRequiredArtifacts(root, SESSION_ID, without(await evidenceSet([]), "LOG"), ["FINAL_GIT", "VERIFICATION"]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.log).toBeNull();
  });

  it("refuses a session recording two LOG artifacts rather than picking one provenance to believe", async () => {
    const artifacts = await evidenceSet([]);
    const second = { ...await realArtifact("LOG", "output-2.ndjson", LOG_LINE), id: "LOG-id-second" };
    const result = await validateRequiredArtifacts(root, SESSION_ID, [...artifacts, second]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/more than one LOG artifact/);
  });

  it("excludes a BASELINE patch from the authoritative part set so it can never stand in for a missing final patch", async () => {
    const artifacts = without(await evidenceSet(["src/a.ts"]), "PATCH");
    const baseline = await realArtifact("PATCH", "baseline-patch.json", canonicalJson(patchArtifact(["src/a.ts"], { patchKind: "BASELINE" })));
    const result = await validateRequiredArtifacts(root, SESSION_ID, [...artifacts, baseline]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parts.some(part => part.category === "PATCH")).toBe(false);
    const conditional = checkConditionalEvidenceRequirements(result.parts);
    expect(conditional.ok).toBe(false);
    if (!conditional.ok) expect(conditional.reason).toMatch(/final patch artifact is required/);
  });

  describe("producer truncation policy", () => {
    for (const category of ["FINAL_GIT", "PATCH", "CHANGED_FILES", "VERIFICATION"] as const) {
      it(`blocks an AUTHORITATIVE review when the writer persisted incomplete ${category} evidence`, async () => {
        const artifacts = (await evidenceSet(["src/a.ts"])).map(artifact => artifact.artifactType === category
          ? { ...artifact, truncated: true, omittedByteCount: 80, truncationMethod: "HEAD" }
          : artifact);
        const result = await validateRequiredArtifacts(root, SESSION_ID, artifacts);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const policy = assertProducerTruncationPolicy(result.parts);
        expect(policy.ok).toBe(false);
        if (!policy.ok) expect(policy.reason).toMatch(new RegExp(`incomplete ${category} evidence`));
      });
    }

    it("does not block on a producer-truncated LOG, which follows the optional/truncatable policy", async () => {
      // Truncated truthfully: the row AND the producer's own provenance both
      // say so, and both describe the same 4,096 omitted bytes.
      const fullStreamHash = createHash("sha256").update(`${LOG_LINE}dropped by the cap`).digest("hex");
      const artifacts = (await evidenceSet([])).map(artifact => artifact.artifactType === "LOG"
        ? {
          ...artifact,
          truncated: true, omittedByteCount: 4_096, truncationMethod: "TAIL",
          originalByteCount: artifact.byteCount + 4_096, fullContentSha256: fullStreamHash,
          provenanceJson: canonicalJson({
            ...completeLogProvenance(LOG_LINE),
            originalRawByteCount: artifact.byteCount + 4_096,
            omittedRawByteCount: 4_096,
            fullRawContentHash: fullStreamHash,
            producerTruncated: true, truncationMethod: "TAIL", captureCompleteness: "TRUNCATED_KNOWN",
            recordCountOriginal: 9
          })
        }
        : artifact);
      const result = await validateRequiredArtifacts(root, SESSION_ID, artifacts);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(assertProducerTruncationPolicy(result.parts).ok).toBe(true);
      // A truthfully truncated log is still authoritative evidence -- what it
      // may never do is claim to be complete.
      expect(assertAuthoritativeLogProvenance(result.log)).toEqual({ ok: true });
    });

    it("blocks when the patch inside a structurally whole envelope was itself truncated by the producer", async () => {
      const artifacts = without(await evidenceSet(["src/a.ts"]), "PATCH");
      const truncatedPatch = await realArtifact("PATCH", "final-patch.json", canonicalJson(patchArtifact(["src/a.ts"], { truncation: truncatedProducerProvenance() })));
      const result = await validateRequiredArtifacts(root, SESSION_ID, [...artifacts, truncatedPatch]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(assertProducerTruncationPolicy(result.parts).ok).toBe(false);
    });

    it("reports truthful original/included/omitted counts rather than claiming completeness", async () => {
      const artifacts = without(await evidenceSet(["src/a.ts"]), "PATCH");
      const truncatedPatch = await realArtifact("PATCH", "final-patch.json", canonicalJson(patchArtifact(["src/a.ts"], { truncation: truncatedProducerProvenance(500, 300) })));
      const result = await validateRequiredArtifacts(root, SESSION_ID, [...artifacts, truncatedPatch]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const patch = result.parts.find(part => part.category === "PATCH")!;
      expect(patch.producerTruncated).toBe(true);
      expect(patch.producerOmittedByteCount).toBe(200);
      expect(patch.producerTruncationMethod).toBe("HEAD");
    });
  });

  describe("conditional PATCH / CHANGED_FILES requirements", () => {
    it("accepts an explicit, valid, empty change set", async () => {
      const result = await validateRequiredArtifacts(root, SESSION_ID, without(await evidenceSet([]), "PATCH"));
      expect(result.ok).toBe(true);
      if (result.ok) expect(checkConditionalEvidenceRequirements(result.parts).ok).toBe(true);
    });

    it("rejects a non-empty change set with no CHANGED_FILES artifact", async () => {
      const result = await validateRequiredArtifacts(root, SESSION_ID, without(await evidenceSet(["src/a.ts"]), "CHANGED_FILES"));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const conditional = checkConditionalEvidenceRequirements(result.parts);
      expect(conditional.ok).toBe(false);
      if (!conditional.ok) expect(conditional.reason).toMatch(/changed-file artifact is required/);
    });

    it("rejects a run that changed nothing but recorded no CHANGED_FILES artifact at all", async () => {
      const artifacts = without(without(await evidenceSet([]), "CHANGED_FILES"), "PATCH");
      const result = await validateRequiredArtifacts(root, SESSION_ID, artifacts);
      expect(result.ok).toBe(true);
      if (result.ok) expect(checkConditionalEvidenceRequirements(result.parts).ok).toBe(false);
    });

    it("rejects a non-empty diff with no PATCH artifact", async () => {
      const result = await validateRequiredArtifacts(root, SESSION_ID, without(await evidenceSet(["src/a.ts"]), "PATCH"));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const conditional = checkConditionalEvidenceRequirements(result.parts);
      expect(conditional.ok).toBe(false);
      if (!conditional.ok) expect(conditional.reason).toMatch(/final patch artifact is required/);
    });

    it("rejects a changed-file artifact that disagrees with the Git evidence", async () => {
      const artifacts = without(await evidenceSet(["src/a.ts"]), "CHANGED_FILES");
      const mismatched = await realArtifact("CHANGED_FILES", "changed-files.json", canonicalJson(changedFilesArtifact([changedFile("src/b.ts")])));
      const result = await validateRequiredArtifacts(root, SESSION_ID, [...artifacts, mismatched]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const conditional = checkConditionalEvidenceRequirements(result.parts);
      expect(conditional.ok).toBe(false);
      if (!conditional.ok) expect(conditional.reason).toMatch(/disagree/);
    });

    it("rejects conflicting statuses for the same path across the two artifacts", async () => {
      const artifacts = without(await evidenceSet(["src/a.ts"]), "CHANGED_FILES");
      const conflicting = await realArtifact("CHANGED_FILES", "changed-files.json", canonicalJson(changedFilesArtifact([changedFile("src/a.ts", { status: "deleted", finalSha256: null })])));
      const result = await validateRequiredArtifacts(root, SESSION_ID, [...artifacts, conflicting]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const conditional = checkConditionalEvidenceRequirements(result.parts);
      expect(conditional.ok).toBe(false);
      if (!conditional.ok) expect(conditional.reason).toMatch(/conflicting statuses/);
    });

    it("rejects a patch that misses coverage for one changed file", async () => {
      const artifacts = without(await evidenceSet(["src/a.ts", "src/b.ts"]), "PATCH");
      const partial = await realArtifact("PATCH", "final-patch.json", canonicalJson(patchArtifact(["src/a.ts"])));
      const result = await validateRequiredArtifacts(root, SESSION_ID, [...artifacts, partial]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const conditional = checkConditionalEvidenceRequirements(result.parts);
      expect(conditional.ok).toBe(false);
      if (!conditional.ok) expect(conditional.reason).toContain("src/b.ts");
    });

    it("accepts a changed file left out of the patch for an explicit, policy-approved reason", async () => {
      const artifacts = without(await evidenceSet([".env"]), "PATCH");
      const omitted = await realArtifact("PATCH", "final-patch.json", canonicalJson(patchArtifact([], { omittedPaths: [{ path: ".env", reason: "SENSITIVE_PATH" }] })));
      const result = await validateRequiredArtifacts(root, SESSION_ID, [...artifacts, omitted]);
      expect(result.ok).toBe(true);
      if (result.ok) expect(checkConditionalEvidenceRequirements(result.parts).ok).toBe(true);
    });
  });
});
