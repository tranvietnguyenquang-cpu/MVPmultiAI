import { z } from "zod";
import { canonicalJson } from "./handoff.js";
import { verificationOperationSchema } from "./handoff.js";
import { truncationMethodSchema } from "./review.js";
import { streamCaptureProvenanceSchema } from "./stream-capture.js";
import { parseRelayPatchPreview } from "./unified-diff.js";
import { sha256OfText } from "./text-safety.js";

/**
 * Canonical, versioned, strict contracts for the persisted execution-evidence
 * artifacts an AUTHORITATIVE review is allowed to be built from.
 *
 * These live in the domain package on purpose: `relay-v2-execution` (the
 * producer) and `relay-v2-reviewer` (the consumer) may not import each other
 * -- enforced by isolation.relay-v2.test.ts -- so a single shared definition
 * here is the only way both sides can be held to the SAME schema rather than
 * to two hand-maintained copies that can silently drift apart.
 *
 * Every object is `.strict()`: an unknown, renamed, or added field is a hard
 * parse failure, never a silently ignored one.
 *
 * The invariant these contracts exist to support: the bytes on disk are the
 * authoritative evidence. A reviewer reads those bytes, re-verifies their
 * size and SHA-256 against the artifact row, decodes them under strict UTF-8,
 * parses them against the schema below, canonicalizes the result, and hashes
 * that. Any database JSON covering the same evidence is a projection that
 * must prove canonical semantic equality with the parsed artifact before it
 * may be used -- see `semanticEvidenceHash`.
 */

export const EVIDENCE_ARTIFACT_SCHEMA_VERSION = "evidence-artifact-v1" as const;

const sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/);
const gitObjectIdSchema = z.string().regex(/^[a-f0-9]{40}$|^[a-f0-9]{64}$/);

/** Rejects an absolute path or any ".."-traversal segment; every persisted evidence path must be repository-relative. */
export const repositoryRelativePathSchema = z.string().min(1).max(4_096).refine(
  value => !/^([a-zA-Z]:)?[\\/]/.test(value) && !value.split(/[\\/]/).includes(".."),
  { message: "must be a safe, repository-relative path (no absolute path, no '..' traversal segment)" }
);

/**
 * Truthful provenance for content the PRODUCER could not persist in full.
 *
 * Every count is computed BEFORE any truncation, from the complete content:
 *   - `originalByteCount` -- the complete content's UTF-8 size;
 *   - `fullContentSha256` -- SHA-256 of the complete content, so a consumer
 *     can always tell that what it holds is not the whole thing even when the
 *     whole thing no longer exists anywhere;
 *   - `includedByteCount` -- what actually got persisted;
 *   - `omittedByteCount` -- `originalByteCount - includedByteCount`.
 *
 * `producerTruncated: false` REQUIRES `omittedByteCount === 0`,
 * `includedByteCount === originalByteCount`, and `truncationMethod === "NONE"`
 * -- the schema refuses to express "nothing was lost" and "bytes are missing"
 * at the same time. Conversely `producerTruncated: true` requires a nonzero
 * omission and a real truncation method: a writer cannot claim truncation
 * while reporting `originalByteCount === includedByteCount` and
 * `omittedByteCount === 0`, which was exactly the inaccurate provenance this
 * contract replaces.
 */
export const producerTruncationSchema = z.object({
  producerTruncated: z.boolean(),
  /**
   * True when an UPSTREAM capture (a bounded process-output read, say) had
   * already discarded bytes before this producer ever saw the content, so the
   * complete size is not knowable and the counts below describe only what the
   * producer actually held. Kept distinct from `producerTruncated` rather than
   * folded into it precisely so the counts never have to be invented: an
   * unknown loss is reported as unknown, not as a guessed `omittedByteCount`.
   * Blocks a critical artifact exactly as `producerTruncated` does.
   */
  captureTruncated: z.boolean(),
  originalByteCount: z.number().int().min(0),
  includedByteCount: z.number().int().min(0),
  omittedByteCount: z.number().int().min(0),
  truncationMethod: truncationMethodSchema,
  fullContentSha256: sha256HexSchema
}).strict().superRefine((value, ctx) => {
  if (value.includedByteCount + value.omittedByteCount !== value.originalByteCount) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "includedByteCount + omittedByteCount must equal originalByteCount" });
  }
  if (!value.producerTruncated && (value.omittedByteCount !== 0 || value.truncationMethod !== "NONE")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "producerTruncated is false but bytes are reported omitted or a truncation method is declared" });
  }
  if (value.producerTruncated && (value.omittedByteCount === 0 || value.truncationMethod === "NONE")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "producerTruncated is true but no bytes are reported omitted and no truncation method is declared" });
  }
});
export type ProducerTruncation = z.infer<typeof producerTruncationSchema>;

/** True when this content cannot be treated as complete, for either reason. */
export function isProvenanceIncomplete(truncation: ProducerTruncation): boolean {
  return truncation.producerTruncated || truncation.captureTruncated;
}

/** The provenance value for content that was persisted whole. */
export function untruncatedProvenance(text: string, captureTruncated = false): ProducerTruncation {
  const byteCount = Buffer.byteLength(text, "utf8");
  return {
    producerTruncated: false, captureTruncated, originalByteCount: byteCount, includedByteCount: byteCount,
    omittedByteCount: 0, truncationMethod: "NONE", fullContentSha256: sha256OfText(text)
  };
}

/**
 * The provenance value for content this producer truncated itself, computed
 * from the COMPLETE content before the cut -- never inferred from the already
 * shortened result.
 */
export function truncatedProvenance(
  completeText: string, includedText: string, truncationMethod: Exclude<ProducerTruncation["truncationMethod"], "NONE">, captureTruncated = false
): ProducerTruncation {
  const originalByteCount = Buffer.byteLength(completeText, "utf8");
  const includedByteCount = Buffer.byteLength(includedText, "utf8");
  return {
    producerTruncated: true, captureTruncated, originalByteCount, includedByteCount,
    omittedByteCount: originalByteCount - includedByteCount, truncationMethod,
    fullContentSha256: sha256OfText(completeText)
  };
}

export const changedFileStatusSchema = z.enum(["added", "modified", "deleted", "renamed"]);
export type ChangedFileStatus = z.infer<typeof changedFileStatusSchema>;

export const changedFileEntrySchema = z.object({
  path: repositoryRelativePathSchema,
  status: changedFileStatusSchema,
  /**
   * Populated only for a `renamed` entry. WorkspaceEvidenceService performs no
   * rename detection today, so a rename surfaces as a delete plus an add and
   * this stays null -- the field exists so a future rename-aware producer has
   * a place to put it that consumers already understand.
   */
  renamedFrom: repositoryRelativePathSchema.nullable(),
  binary: z.boolean().nullable(),
  baselineSha256: sha256HexSchema.nullable(),
  finalSha256: sha256HexSchema.nullable()
}).strict();
export type ChangedFileEntry = z.infer<typeof changedFileEntrySchema>;

/** Rejects duplicate or conflicting normalized paths within one changed-file set. */
function refineDistinctPaths(entries: readonly { path: string }[], ctx: z.RefinementCtx, field: string): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    const normalized = entry.path.replace(/\\/g, "/");
    if (seen.has(normalized)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `duplicate or conflicting changed-file path '${normalized}'` });
    }
    seen.add(normalized);
  }
}

// ---------------------------------------------------------------------------
// FINAL_GIT
// ---------------------------------------------------------------------------

export const finalGitArtifactSchema = z.object({
  schemaVersion: z.literal(EVIDENCE_ARTIFACT_SCHEMA_VERSION),
  artifactType: z.literal("FINAL_GIT"),
  branch: z.string().max(500),
  head: gitObjectIdSchema,
  /** True when the working tree had no recorded status entries at capture time. The inverse of the persisted `dirty` flag, stated positively so "clean" is not an inference. */
  clean: z.boolean(),
  changedFileCount: z.number().int().min(0),
  changedFiles: z.array(changedFileEntrySchema).max(5_000),
  /** SHA-256 of the complete, canonicalized `{ evidence, delta }` capture this artifact was rendered from -- the producer's own end-to-end identity for this Git evidence. */
  fullEvidenceHash: sha256HexSchema,
  /** The self-referential `evidenceHash` WorkspaceEvidenceService computed over its own capture. */
  captureEvidenceHash: sha256HexSchema,
  capturedAt: z.string().datetime(),
  forbiddenGitMutationSuspected: z.boolean(),
  truncation: producerTruncationSchema
}).strict().superRefine((value, ctx) => {
  if (value.changedFileCount !== value.changedFiles.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["changedFileCount"], message: "changedFileCount must equal the number of changed-file entries" });
  }
  refineDistinctPaths(value.changedFiles, ctx, "changedFiles");
});
export type FinalGitArtifact = z.infer<typeof finalGitArtifactSchema>;

// ---------------------------------------------------------------------------
// PATCH
// ---------------------------------------------------------------------------

export const patchArtifactSchema = z.object({
  schemaVersion: z.literal(EVIDENCE_ARTIFACT_SCHEMA_VERSION),
  artifactType: z.literal("PATCH"),
  /** FINAL is the reviewable delta produced by the run; BASELINE records pre-existing workspace dirt and is never a substitute for it. */
  patchKind: z.enum(["FINAL", "BASELINE"]),
  baselineHead: gitObjectIdSchema,
  finalHead: gitObjectIdSchema,
  unifiedDiff: z.string(),
  /** Every changed path this diff actually evidences. */
  coveredPaths: z.array(repositoryRelativePathSchema).max(5_000),
  /**
   * Paths deliberately left out of the diff together with the policy reason.
   * The only reason a producer may emit today is sensitive-path omission;
   * an omission with any other reason is rejected downstream rather than
   * quietly accepted as coverage.
   */
  omittedPaths: z.array(z.object({
    path: repositoryRelativePathSchema,
    reason: z.enum(["SENSITIVE_PATH"])
  }).strict()).max(5_000),
  fullContentHash: sha256HexSchema,
  truncation: producerTruncationSchema
}).strict().superRefine((value, ctx) => {
  const seen = new Set<string>();
  for (const path of value.coveredPaths) {
    const normalized = path.replace(/\\/g, "/");
    if (seen.has(normalized)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["coveredPaths"], message: `duplicate covered path '${normalized}'` });
    seen.add(normalized);
  }
  for (const entry of value.omittedPaths) {
    if (seen.has(entry.path.replace(/\\/g, "/"))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["omittedPaths"], message: `path '${entry.path}' is reported both covered and omitted` });
    }
  }
  // Coverage must be provable from the diff's own HEADERS. A claim that some
  // path is covered is checked against the parsed header set, so a path that
  // merely APPEARS in another file's hunk body can never satisfy it. Skipped
  // only for a producer-truncated diff, whose headers are provably incomplete
  // -- and which is separately refused by an AUTHORITATIVE review anyway.
  if (!value.truncation.producerTruncated && !value.truncation.captureTruncated) {
    const parsed = parseRelayPatchPreview(value.unifiedDiff);
    if (!parsed.ok) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["unifiedDiff"], message: `unified diff cannot be parsed, so it cannot prove coverage: ${parsed.reason}` });
      return;
    }
    const headerPaths = new Set(parsed.paths);
    for (const path of value.coveredPaths) {
      if (!headerPaths.has(path.replace(/\\/g, "/"))) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["coveredPaths"], message: `path '${path}' is declared covered but no unified-diff file header names it` });
      }
    }
  }
});
export type PatchArtifact = z.infer<typeof patchArtifactSchema>;

// ---------------------------------------------------------------------------
// CHANGED_FILES
// ---------------------------------------------------------------------------

export const changedFilesArtifactSchema = z.object({
  schemaVersion: z.literal(EVIDENCE_ARTIFACT_SCHEMA_VERSION),
  artifactType: z.literal("CHANGED_FILES"),
  /** Explicitly present and empty for a run that touched no files -- never an absent artifact. */
  files: z.array(changedFileEntrySchema).max(5_000),
  fileCount: z.number().int().min(0),
  /** SHA-256 over the canonicalized `files` array; a manifest identity independent of this envelope's own framing. */
  manifestHash: sha256HexSchema,
  truncation: producerTruncationSchema
}).strict().superRefine((value, ctx) => {
  if (value.fileCount !== value.files.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["fileCount"], message: "fileCount must equal the number of file entries" });
  }
  refineDistinctPaths(value.files, ctx, "files");
  if (value.manifestHash !== sha256OfText(canonicalJson(value.files))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["manifestHash"], message: "manifestHash does not match the canonicalized file list it claims to cover" });
  }
});
export type ChangedFilesArtifact = z.infer<typeof changedFilesArtifactSchema>;

// ---------------------------------------------------------------------------
// VERIFICATION
// ---------------------------------------------------------------------------

export const verificationArtifactResultSchema = z.object({
  operation: verificationOperationSchema,
  displayCommand: z.string().max(200),
  status: z.enum(["PASSED", "FAILED", "TIMED_OUT", "CANCELLED"]),
  exitCode: z.number().int().nullable(),
  summary: z.string().max(2_000),
  stdout: z.string(),
  stdoutTruncation: producerTruncationSchema,
  stderr: z.string(),
  stderrTruncation: producerTruncationSchema,
  /**
   * Runner-boundary output accounting. Recorded even when it says output was
   * lost: an artifact that cannot express "this operation passed but some of
   * its output never reached us" is an artifact that will eventually assert
   * the opposite. Whether such a result may authorize a review is a REVIEWER
   * policy decision (it may not -- see assertVerificationCaptureCompleteness),
   * never something this schema quietly resolves by refusing to record it.
   */
  runnerOutputTruncated: z.boolean(),
  runnerStdoutBytes: z.number().int().min(0),
  runnerStderrBytes: z.number().int().min(0),
  stdoutCapture: streamCaptureProvenanceSchema,
  stderrCapture: streamCaptureProvenanceSchema,
  startedAt: z.string(),
  finishedAt: z.string(),
  /** The self-referential integrity hash VerificationCatalogRunner computed over this exact result. */
  resultHash: sha256HexSchema
}).strict().superRefine((value, ctx) => {
  if (value.status === "PASSED" && value.exitCode !== 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["exitCode"], message: "a verification result marked PASSED must have exit code 0" });
  }
  if (value.stdoutCapture.stream !== "stdout") ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["stdoutCapture"], message: "stdoutCapture must describe the stdout stream" });
  if (value.stderrCapture.stream !== "stderr") ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["stderrCapture"], message: "stderrCapture must describe the stderr stream" });
  // The aggregate flag and the per-stream detail must agree in the direction
  // that matters: a runner that reported discarded output can never be paired
  // with two streams that both claim complete capture.
  if (value.runnerOutputTruncated && value.stdoutCapture.captureCompleteness === "COMPLETE" && value.stderrCapture.captureCompleteness === "COMPLETE") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "the process runner reported discarded output, but neither stream records any loss" });
  }
});
export type VerificationArtifactResult = z.infer<typeof verificationArtifactResultSchema>;

export const verificationArtifactSchema = z.object({
  schemaVersion: z.literal(EVIDENCE_ARTIFACT_SCHEMA_VERSION),
  artifactType: z.literal("VERIFICATION"),
  results: z.array(verificationArtifactResultSchema).max(10),
  /** SHA-256 over the canonicalized `results` array. */
  fullContentHash: sha256HexSchema,
  truncation: producerTruncationSchema
}).strict().superRefine((value, ctx) => {
  const seen = new Set<string>();
  for (const result of value.results) {
    if (seen.has(result.operation)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["results"], message: `duplicate verification operation '${result.operation}'` });
    seen.add(result.operation);
  }
  if (value.fullContentHash !== sha256OfText(canonicalJson(value.results))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["fullContentHash"], message: "fullContentHash does not match the canonicalized results it claims to cover" });
  }
});
export type VerificationArtifact = z.infer<typeof verificationArtifactSchema>;

// ---------------------------------------------------------------------------
// LOG
// ---------------------------------------------------------------------------

/**
 * The `LOG` artifact is a raw NDJSON text stream, not a JSON document, so its
 * contract is carried on the artifact ROW rather than inside the file: a
 * versioned text-artifact contract whose fields the reviewer validates against
 * the real bytes exactly as it does for the JSON categories. LOG is the one
 * category whose producer truncation is policy-permitted (see
 * EVIDENCE_CATEGORY_TRUNCATION_POLICY's OPTIONAL class) rather than blocking.
 */
export const logArtifactContractSchema = z.object({
  schemaVersion: z.literal(EVIDENCE_ARTIFACT_SCHEMA_VERSION),
  artifactType: z.literal("LOG"),
  contentType: z.literal("application/x-ndjson"),
  encoding: z.literal("utf8"),
  /** SHA-256 of the ORIGINAL raw bytes, before any producer truncation and independent of any decoding. */
  rawContentHash: sha256HexSchema,
  truncation: producerTruncationSchema
}).strict();
export type LogArtifactContract = z.infer<typeof logArtifactContractSchema>;

// ---------------------------------------------------------------------------
// Parsing / canonical semantic hashing
// ---------------------------------------------------------------------------

export type EvidenceArtifactCategory = "FINAL_GIT" | "PATCH" | "CHANGED_FILES" | "VERIFICATION";

const parsersByCategory = {
  FINAL_GIT: finalGitArtifactSchema,
  PATCH: patchArtifactSchema,
  CHANGED_FILES: changedFilesArtifactSchema,
  VERIFICATION: verificationArtifactSchema
} as const;

export type ParsedEvidenceArtifact =
  | { category: "FINAL_GIT"; value: FinalGitArtifact }
  | { category: "PATCH"; value: PatchArtifact }
  | { category: "CHANGED_FILES"; value: ChangedFilesArtifact }
  | { category: "VERIFICATION"; value: VerificationArtifact };

export type EvidenceArtifactParseResult =
  | { ok: true; artifact: ParsedEvidenceArtifact }
  | { ok: false; reason: string };

/**
 * Parses already-strictly-decoded artifact text against the versioned schema
 * for its category. A schema version this build does not know, an unknown
 * field, or a shape mismatch is always a hard failure -- never a partial
 * acceptance and never a downgrade to a permissive reading.
 */
export function parseEvidenceArtifact(category: EvidenceArtifactCategory, text: string, label: string): EvidenceArtifactParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: `${label} is not valid JSON and cannot be used as authoritative evidence.` };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: `${label} is not a JSON object and cannot be used as authoritative evidence.` };
  }
  const declaredVersion = (raw as Record<string, unknown>).schemaVersion;
  if (declaredVersion !== EVIDENCE_ARTIFACT_SCHEMA_VERSION) {
    return { ok: false, reason: `${label} declares evidence artifact schema version ${JSON.stringify(declaredVersion)}, which this build does not support (expected ${EVIDENCE_ARTIFACT_SCHEMA_VERSION}).` };
  }
  const result = parsersByCategory[category].safeParse(raw);
  if (!result.success) {
    return { ok: false, reason: `${label} failed strict ${category} artifact schema validation: ${result.error.issues[0]?.message ?? "invalid shape"}.` };
  }
  return { ok: true, artifact: { category, value: result.data } as ParsedEvidenceArtifact };
}

/**
 * The canonical SEMANTIC value of a parsed artifact: exactly the evidence
 * meaning, with the envelope's own framing (schemaVersion, artifactType,
 * self-hashes) removed so it can be compared against an equivalent value
 * derived from a different representation -- specifically, the projection
 * stored in the database.
 *
 * This is the one place the semantic shape of each category is defined. The
 * artifact side and the database side must both be reduced through it; a
 * comparison that reduced only one side would prove nothing.
 */
export function canonicalEvidenceSemantics(artifact: ParsedEvidenceArtifact): unknown {
  switch (artifact.category) {
    case "FINAL_GIT":
      return {
        branch: artifact.value.branch,
        head: artifact.value.head,
        clean: artifact.value.clean,
        changedFiles: [...artifact.value.changedFiles]
          .map(file => ({ path: file.path.replace(/\\/g, "/"), status: file.status, renamedFrom: file.renamedFrom, binary: file.binary, baselineSha256: file.baselineSha256, finalSha256: file.finalSha256 }))
          .sort((left, right) => left.path.localeCompare(right.path)),
        captureEvidenceHash: artifact.value.captureEvidenceHash,
        forbiddenGitMutationSuspected: artifact.value.forbiddenGitMutationSuspected
      };
    case "PATCH":
      return {
        patchKind: artifact.value.patchKind,
        baselineHead: artifact.value.baselineHead,
        finalHead: artifact.value.finalHead,
        unifiedDiff: artifact.value.unifiedDiff,
        coveredPaths: [...artifact.value.coveredPaths].map(path => path.replace(/\\/g, "/")).sort((left, right) => left.localeCompare(right)),
        omittedPaths: [...artifact.value.omittedPaths].map(entry => ({ path: entry.path.replace(/\\/g, "/"), reason: entry.reason })).sort((left, right) => left.path.localeCompare(right.path))
      };
    case "CHANGED_FILES":
      return {
        files: [...artifact.value.files]
          .map(file => ({ path: file.path.replace(/\\/g, "/"), status: file.status, renamedFrom: file.renamedFrom, binary: file.binary, baselineSha256: file.baselineSha256, finalSha256: file.finalSha256 }))
          .sort((left, right) => left.path.localeCompare(right.path))
      };
    case "VERIFICATION":
      return {
        results: artifact.value.results.map(result => ({
          operation: result.operation,
          displayCommand: result.displayCommand,
          status: result.status,
          exitCode: result.exitCode,
          summary: result.summary,
          stdout: result.stdout,
          stderr: result.stderr,
          // Capture provenance is part of the MEANING of a verification
          // result, not decoration around it: "passed with complete output"
          // and "passed with output lost upstream" are different facts, and
          // the database projection must reproduce whichever one is true.
          runnerOutputTruncated: result.runnerOutputTruncated,
          runnerStdoutBytes: result.runnerStdoutBytes,
          runnerStderrBytes: result.runnerStderrBytes,
          stdoutCapture: result.stdoutCapture,
          stderrCapture: result.stderrCapture,
          startedAt: result.startedAt,
          finishedAt: result.finishedAt,
          resultHash: result.resultHash
        }))
      };
  }
}

/** SHA-256 over an artifact's canonical semantics -- the value both the artifact side and the database side must agree on exactly. */
export function semanticEvidenceHash(artifact: ParsedEvidenceArtifact): string {
  return sha256OfText(canonicalJson(canonicalEvidenceSemantics(artifact)));
}

/** SHA-256 over any already-reduced semantic value, for the database-projection side of the same comparison. */
export function semanticValueHash(value: unknown): string {
  return sha256OfText(canonicalJson(value));
}
