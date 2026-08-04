import { createHash } from "node:crypto";
import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  canonicalEvidenceSemantics, decodeStrictUtf8, EVIDENCE_ARTIFACT_SCHEMA_VERSION, isProvenanceIncomplete,
  logArtifactContractSchema, logProvenanceSchema, parseEvidenceArtifact, parseRelayPatchPreview, semanticEvidenceHash,
  sha256OfBytes, validateLogRecords,
  type EvidenceArtifactCategory, type LogProvenance, type LogRecord, type ParsedEvidenceArtifact
} from "@project-relay/relay-v2-domain";

export type ArtifactRecord = {
  id: string;
  sessionId: string;
  artifactType: string;
  relativePath: string;
  sha256: string;
  byteCount: number;
  truncated: boolean;
  /** Producer provenance -- see ExecutionArtifactStore.ArtifactMetadata. */
  schemaVersion: string;
  fullContentSha256: string;
  originalByteCount: number;
  omittedByteCount: number;
  truncationMethod: string;
  /** The producer's own versioned provenance object, verbatim. `{}` when the type carries none. */
  provenanceJson: string;
};

export type ArtifactValidationResult = { ok: true; content: Buffer } | { ok: false; reason: string };

/** Per-artifact byte cap for a review-bound artifact read -- generous enough for any bounded/redacted execution artifact, small enough to bound memory. */
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;

/**
 * Reads one ExecutionArtifact's real bytes from the application-owned
 * artifact store and independently re-verifies every claim its database row
 * makes about them, before that content is ever trusted as reviewer evidence.
 * Never trusts database metadata alone (a row can be stale, corrupted, or --
 * in principle -- point somewhere it should not). Checks, in order:
 *   - the artifact belongs to the exact execution session under review;
 *   - the artifact id is one of the ids the caller says are bound to this
 *     review (the `boundArtifactIds` set) -- an artifact that exists in the
 *     database but was never selected into the reviewed evidence set is
 *     refused just as hard as one that does not exist at all;
 *   - the resolved path stays inside the canonical artifacts root, with no
 *     absolute-path injection, `..` traversal, or symlink/junction/
 *     reparse-point escape (both the literal join AND the realpath'd target
 *     are re-checked against the root);
 *   - the target is a regular file, not a directory or special file;
 *   - the file is within the per-artifact size limit;
 *   - the byte count read matches the row's own byteCount;
 *   - a freshly computed SHA-256 matches the row's own sha256.
 * Returns the real bytes only when every check passes; otherwise a specific,
 * non-thrown reason the caller must treat as blocking (ERROR/STALE), never a
 * silently substituted empty value.
 */
export async function validateExecutionArtifact(
  artifactsRoot: string,
  executionSessionId: string,
  boundArtifactIds: ReadonlySet<string>,
  artifact: ArtifactRecord
): Promise<ArtifactValidationResult> {
  if (artifact.sessionId !== executionSessionId) {
    return { ok: false, reason: `Artifact ${artifact.id} (${artifact.artifactType}) belongs to a different execution session and cannot be used as evidence.` };
  }
  if (!boundArtifactIds.has(artifact.id)) {
    return { ok: false, reason: `Artifact ${artifact.id} (${artifact.artifactType}) is not part of the bound artifact set for this review.` };
  }

  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(artifactsRoot);
  } catch {
    return { ok: false, reason: "The execution artifact storage root could not be resolved." };
  }

  if (path.isAbsolute(artifact.relativePath) || artifact.relativePath.split(/[\\/]/).includes("..")) {
    return { ok: false, reason: `Artifact ${artifact.id} (${artifact.artifactType}) has an unsafe stored path.` };
  }
  const joined = path.resolve(canonicalRoot, artifact.relativePath);
  const joinedRelative = path.relative(canonicalRoot, joined);
  if (!joinedRelative || joinedRelative.startsWith("..") || path.isAbsolute(joinedRelative)) {
    return { ok: false, reason: `Artifact ${artifact.id} (${artifact.artifactType}) resolves outside the artifact storage root.` };
  }

  let resolvedTarget: string;
  try {
    resolvedTarget = await realpath(joined);
  } catch {
    return { ok: false, reason: `Artifact ${artifact.id} (${artifact.artifactType}) could not be read from the artifact store.` };
  }
  const resolvedRelative = path.relative(canonicalRoot, resolvedTarget);
  if (!resolvedRelative || resolvedRelative.startsWith("..") || path.isAbsolute(resolvedRelative)) {
    return { ok: false, reason: `Artifact ${artifact.id} (${artifact.artifactType}) resolves (via symlink/junction/reparse point) outside the artifact storage root.` };
  }

  const info = await stat(resolvedTarget);
  if (!info.isFile()) {
    return { ok: false, reason: `Artifact ${artifact.id} (${artifact.artifactType}) is not a regular file.` };
  }
  if (info.size > MAX_ARTIFACT_BYTES) {
    return { ok: false, reason: `Artifact ${artifact.id} (${artifact.artifactType}) exceeds the per-artifact size limit for review evidence.` };
  }

  const handle = await open(resolvedTarget, "r");
  let content: Buffer;
  try {
    content = await handle.readFile();
  } finally {
    await handle.close();
  }

  if (content.byteLength !== artifact.byteCount) {
    return { ok: false, reason: `Artifact ${artifact.id} (${artifact.artifactType}) byte count (${content.byteLength}) does not match its persisted metadata (${artifact.byteCount}).` };
  }
  // Hash the ORIGINAL raw bytes -- never a decoded/re-encoded string, whose
  // bytes would differ from these the moment decoding was lossy.
  const computedSha256 = sha256OfBytes(content);
  if (computedSha256 !== artifact.sha256) {
    return { ok: false, reason: `Artifact ${artifact.id} (${artifact.artifactType}) content hash does not match its persisted metadata.` };
  }

  return { ok: true, content };
}

/**
 * One artifact, proven all the way from bytes to meaning, frozen.
 *
 * Every downstream consumer -- the rendered material, the manifest, the byte
 * ledger, and the prompt -- is built from this same object set. Nothing
 * re-reads a path after validating it, and nothing renders a value it did not
 * measure: that split (validate A, then render B) is exactly what makes an
 * "integrity-checked" pipeline prove nothing.
 */
export type ValidatedReviewEvidencePart = {
  category: EvidenceArtifactCategory | "LOG";
  artifactId: string;
  relativePath: string;
  schemaVersion: string;
  /** SHA-256 of the exact validated raw bytes. */
  rawBytesHash: string;
  /** SHA-256 of the canonical SEMANTICS -- the value a database projection of the same evidence must reproduce exactly. Empty for LOG, a text artifact with no structured semantics. */
  semanticHash: string;
  originalRawByteCount: number;
  /** The canonical semantic value itself, for equality comparison. Null for LOG. */
  parsedCanonicalValue: unknown;
  /** The parsed artifact, for callers that need category-specific fields (changed-file coverage, patch kind). Null for LOG. */
  parsed: ParsedEvidenceArtifact | null;
  /** The complete, strictly-decoded text of the artifact. All rendering starts here -- never from a second read. */
  decodedText: string;
  producerTruncated: boolean;
  producerOmittedByteCount: number;
  producerTruncationMethod: string;
  /** The producer's own LOG provenance, verbatim. Null for every non-LOG category, and for a LOG row that predates the provenance contract. */
  logProvenance?: LogProvenance | null;
};

/** Parses the producer's stored provenance object. An absent one is legitimate (`{}`); a malformed one is not. */
function parseLogProvenance(provenanceJson: string, label: string): { ok: true; value: LogProvenance | null } | { ok: false; reason: string } {
  if (!provenanceJson || provenanceJson === "{}") return { ok: true, value: null };
  let raw: unknown;
  try {
    raw = JSON.parse(provenanceJson);
  } catch {
    return { ok: false, reason: `${label} carries producer provenance that is not valid JSON.` };
  }
  const parsed = logProvenanceSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: `${label} carries producer provenance that fails its versioned contract: ${parsed.error.issues[0]?.message ?? "invalid shape"}.` };
  }
  return { ok: true, value: parsed.data };
}

/**
 * The COMPLETE, immutable validated LOG evidence: the exact bytes, their
 * strict decode, every validated record, and the producer's own provenance --
 * one object, carried unbroken from artifact validation to the rendered
 * material.
 *
 * The defect this closes: all of this was validated here and then only
 * `(bytes, artifactRow.truncated)` was handed to the summarizer. The
 * producer's provenance -- the only account of what the FULL stream was, how
 * much of it survived, and whether the producer could even prove completeness
 * -- was dropped between validation and the capsule, so the reviewer was told
 * `provenanceDisclosure.executionLog: null` about a log whose provenance had
 * been validated moments earlier. Nothing downstream may rebuild provenance
 * from parts (a row's `truncated` flag, a database default, an inferred byte
 * count): it travels whole, or the authoritative review fails closed.
 */
export type ValidatedLogEvidencePart = {
  artifactId: string;
  relativePath: string;
  /** SHA-256 of the exact validated included raw bytes. */
  rawBytesHash: string;
  /** The exact bytes byte-level validation read and hash-verified; never a second read of the file. */
  validatedIncludedBytes: Buffer;
  /** Strict-UTF-8 decode of exactly those bytes. */
  validatedText: string;
  /** Every included record, already validated against the versioned record schema. */
  parsedRecords: readonly LogRecord[];
  /** The producer's own versioned provenance object, verbatim -- never re-derived from the row's scalar columns. Null only for a row that predates the provenance contract, which can never be AUTHORITATIVE (see assertAuthoritativeLogProvenance). */
  logProvenance: LogProvenance | null;
  producerTruncated: boolean;
  /** The artifact ROW's own account of the complete stream, kept alongside the producer's so the two can be re-proved identical rather than merged. */
  producerOriginalByteCount: number;
  producerOmittedByteCount: number;
  producerTruncationMethod: string;
};

/**
 * The one failure code for "the artifact row and the producer provenance are
 * each valid, but they describe different streams". Distinct from an
 * unreadable store or drifted evidence: nothing here is missing or changed,
 * the two records of the same log simply contradict each other, and neither
 * may be preferred over the other.
 */
export const LOG_PROVENANCE_ARTIFACT_MISMATCH = "LOG_PROVENANCE_ARTIFACT_MISMATCH" as const;
export type LogProvenanceArtifactMismatchCode = typeof LOG_PROVENANCE_ARTIFACT_MISMATCH;

export type EvidencePartResult =
  | { ok: true; part: ValidatedReviewEvidencePart; log?: ValidatedLogEvidencePart }
  | { ok: false; reason: string; code?: LogProvenanceArtifactMismatchCode };

export type LogProvenanceCrossCheck = { ok: true } | { ok: false; reason: string; code: LogProvenanceArtifactMismatchCode };

/**
 * Requires the artifact ROW and the producer's LOG PROVENANCE to describe ONE
 * identical stream, after each has passed its own validation.
 *
 * The defect this closes: both representations could be individually,
 * internally valid and still disagree about the same log -- a row reporting
 * 999 omitted bytes with method HEAD_AND_TAIL alongside provenance reporting 1
 * omitted byte with method TAIL. Every self-consistency check passed, because
 * each record was only ever checked against itself. Two irreconcilable
 * accounts of what the producer captured is not evidence about the run; it is
 * evidence that one of the two is fabricated, and nothing here may pick a
 * winner, infer the missing value, or normalize the pair into one number.
 *
 * Runs on the exact validated bytes and the exact validated records -- never
 * on a re-read or a re-parse -- and only after ownership, bound-set, path
 * containment, regular-file, byte-count, raw-hash, strict-UTF-8, NDJSON, and
 * internal-provenance validation have all passed.
 */
export function assertArtifactRowMatchesLogProvenance(input: {
  artifact: ArtifactRecord;
  validatedRawBytes: Buffer;
  parsedRecords: readonly LogRecord[];
  provenance: LogProvenance;
}): LogProvenanceCrossCheck {
  const { artifact, validatedRawBytes, parsedRecords, provenance } = input;
  const label = `Artifact ${artifact.id} (${artifact.artifactType})`;
  const mismatch = (detail: string): LogProvenanceCrossCheck =>
    ({ ok: false, code: LOG_PROVENANCE_ARTIFACT_MISMATCH, reason: `${label}: its artifact row and its producer provenance describe different log streams (${detail}); neither account may be preferred over the other, so this evidence cannot be used.` });

  // --- the bytes themselves, and each record's own arithmetic --------------
  const includedByteCount = validatedRawBytes.byteLength;
  if (artifact.byteCount !== includedByteCount) {
    return mismatch(`row byteCount ${artifact.byteCount} vs ${includedByteCount} validated byte(s)`);
  }
  if (artifact.originalByteCount !== artifact.byteCount + artifact.omittedByteCount) {
    return mismatch(`row originalByteCount ${artifact.originalByteCount} != byteCount ${artifact.byteCount} + omittedByteCount ${artifact.omittedByteCount}`);
  }
  if (provenance.originalRawByteCount !== provenance.includedRawByteCount + provenance.omittedRawByteCount) {
    return mismatch(`provenance originalRawByteCount ${provenance.originalRawByteCount} != includedRawByteCount ${provenance.includedRawByteCount} + omittedRawByteCount ${provenance.omittedRawByteCount}`);
  }

  // --- the same stream, field by overlapping field -------------------------
  if (provenance.includedRawByteCount !== includedByteCount) {
    return mismatch(`provenance includedRawByteCount ${provenance.includedRawByteCount} vs ${includedByteCount} validated byte(s)`);
  }
  if (provenance.originalRawByteCount !== artifact.originalByteCount) {
    return mismatch(`provenance originalRawByteCount ${provenance.originalRawByteCount} vs row originalByteCount ${artifact.originalByteCount}`);
  }
  if (provenance.includedRawByteCount !== artifact.byteCount) {
    return mismatch(`provenance includedRawByteCount ${provenance.includedRawByteCount} vs row byteCount ${artifact.byteCount}`);
  }
  if (provenance.omittedRawByteCount !== artifact.omittedByteCount) {
    return mismatch(`provenance omittedRawByteCount ${provenance.omittedRawByteCount} vs row omittedByteCount ${artifact.omittedByteCount}`);
  }
  if (artifact.omittedByteCount > 0 && !artifact.truncated) {
    return mismatch(`row reports ${artifact.omittedByteCount} omitted byte(s) while recording itself as untruncated`);
  }
  if (provenance.producerTruncated !== artifact.truncated) {
    return mismatch(`provenance producerTruncated ${provenance.producerTruncated} vs row truncated ${artifact.truncated}`);
  }
  if (provenance.truncationMethod !== artifact.truncationMethod) {
    return mismatch(`provenance truncationMethod ${provenance.truncationMethod} vs row truncationMethod ${artifact.truncationMethod}`);
  }

  // --- hashes, against a fresh computation over the exact validated bytes ---
  const freshIncludedHash = sha256OfBytes(validatedRawBytes);
  if (provenance.includedContentHash !== freshIncludedHash) {
    return mismatch("provenance includedContentHash is not the hash of the exact validated included bytes");
  }
  if (artifact.sha256 !== freshIncludedHash) {
    return mismatch("row sha256 is not the hash of the exact validated included bytes");
  }
  // `fullRawContentHash`/`fullContentSha256` both mean the COMPLETE producer
  // stream. When the producer could not hold that stream it says so with a
  // null hash, and the row falls back to the stored bytes' hash -- so the two
  // are compared under those documented semantics rather than for raw equality.
  if (provenance.captureCompleteness === "TRUNCATED_UNKNOWN") {
    if (provenance.fullRawContentHash !== null) {
      return mismatch("provenance claims a complete-stream hash for a stream it never held in full");
    }
    if (artifact.fullContentSha256 !== freshIncludedHash) {
      return mismatch("row fullContentSha256 claims a complete stream its own provenance says was never held in full");
    }
  } else {
    if (provenance.fullRawContentHash !== artifact.fullContentSha256) {
      return mismatch("provenance fullRawContentHash vs row fullContentSha256");
    }
    if (!provenance.producerTruncated && provenance.fullRawContentHash !== freshIncludedHash) {
      return mismatch("an untruncated log declares a complete-stream hash that is not the hash of its own bytes");
    }
  }

  // --- records ------------------------------------------------------------
  if (provenance.recordCountIncluded !== parsedRecords.length) {
    return mismatch(`provenance recordCountIncluded ${provenance.recordCountIncluded} vs ${parsedRecords.length} validated NDJSON record(s)`);
  }
  if (provenance.recordCountOriginal !== null) {
    if (provenance.captureCompleteness === "TRUNCATED_UNKNOWN") {
      return mismatch("provenance states an original record count for a stream whose completeness it reports as unknown");
    }
    if (provenance.recordCountOriginal < provenance.recordCountIncluded) {
      return mismatch(`provenance recordCountOriginal ${provenance.recordCountOriginal} < recordCountIncluded ${provenance.recordCountIncluded}`);
    }
    if (!provenance.producerTruncated && provenance.recordCountOriginal !== provenance.recordCountIncluded) {
      return mismatch(`an untruncated log declares recordCountOriginal ${provenance.recordCountOriginal} and recordCountIncluded ${provenance.recordCountIncluded}`);
    }
  }
  if (provenance.captureCompleteness === "COMPLETE" && provenance.producerTruncated) {
    return mismatch("provenance reports COMPLETE capture and producer truncation at the same time");
  }
  if (provenance.captureCompleteness === "TRUNCATED_KNOWN" && !provenance.producerTruncated) {
    return mismatch("provenance reports a known truncation while also reporting that the producer did not truncate");
  }
  return { ok: true };
}

/**
 * Turns validated bytes into a `ValidatedReviewEvidencePart`: strict UTF-8
 * decode, strict versioned parse, canonicalization, semantic hash.
 *
 * Producer truncation is NOT decided here -- a category's tolerance for it is
 * policy (see `assertProducerTruncationPolicy`), and this function's job is
 * only to report it faithfully.
 */
export function buildEvidencePart(
  artifact: ArtifactRecord, content: Buffer, category: EvidenceArtifactCategory | "LOG"
): EvidencePartResult {
  const label = `Artifact ${artifact.id} (${artifact.artifactType})`;
  const decoded = decodeStrictUtf8(content, label);
  if (!decoded.ok) return { ok: false, reason: decoded.reason };

  const rawBytesHash = sha256OfBytes(content);
  const producerTruncated = artifact.truncated || artifact.omittedByteCount > 0;

  if (category === "LOG") {
    // The LOG artifact is raw NDJSON text, so its versioned contract lives on
    // the row rather than inside the file. It is validated exactly as
    // strictly as the JSON categories.
    const contract = logArtifactContractSchema.safeParse({
      schemaVersion: artifact.schemaVersion,
      artifactType: "LOG",
      contentType: "application/x-ndjson",
      encoding: "utf8",
      rawContentHash: artifact.fullContentSha256,
      truncation: {
        producerTruncated,
        captureTruncated: false,
        originalByteCount: artifact.originalByteCount,
        includedByteCount: artifact.originalByteCount - artifact.omittedByteCount,
        omittedByteCount: artifact.omittedByteCount,
        truncationMethod: artifact.truncationMethod,
        fullContentSha256: artifact.fullContentSha256
      }
    });
    if (!contract.success) {
      return { ok: false, reason: `${label} failed its versioned LOG text-artifact contract: ${contract.error.issues[0]?.message ?? "invalid shape"}.` };
    }
    // A LOG that was NOT truncated must hash identically stored-vs-complete;
    // otherwise the row is describing different bytes than the ones on disk.
    if (!producerTruncated && contract.data.rawContentHash !== rawBytesHash) {
      return { ok: false, reason: `${label} declares a complete-content hash that does not match its own untruncated bytes.` };
    }

    // The producer's own provenance object, carried through UNCHANGED rather
    // than re-derived from the row's scalar columns -- re-deriving would
    // quietly upgrade an honest "I cannot prove this is complete" into a claim
    // of completeness the producer never made. It is still cross-checked
    // against the real bytes: a provenance that does not describe THESE bytes
    // is a hard failure, not a preference for one source over the other.
    const provenance = parseLogProvenance(artifact.provenanceJson, label);
    if (!provenance.ok) return provenance;

    // Every INCLUDED record must be a complete, well-formed, schema-valid
    // NDJSON object. A partial trailing line, a JSON array, or an unknown
    // record shape is refused here rather than embedded into the review
    // material as if it were a trustworthy transcript.
    const records = validateLogRecords(decoded.text, label);
    if (!records.ok) return { ok: false, reason: records.reason };

    // Both records of this log have now passed their own validation. The last
    // thing that must hold -- and the thing that used to be missing entirely --
    // is that they are records of the SAME log. This is the production
    // boundary: no authoritative LOG evidence part is ever returned from a
    // contradictory pair.
    if (provenance.value) {
      const agreement = assertArtifactRowMatchesLogProvenance({
        artifact, validatedRawBytes: content, parsedRecords: records.records, provenance: provenance.value
      });
      if (!agreement.ok) return agreement;
    }

    return {
      ok: true,
      part: {
        category: "LOG", artifactId: artifact.id, relativePath: artifact.relativePath,
        schemaVersion: artifact.schemaVersion, rawBytesHash, semanticHash: "",
        originalRawByteCount: artifact.originalByteCount, parsedCanonicalValue: null, parsed: null,
        decodedText: decoded.text, producerTruncated,
        producerOmittedByteCount: artifact.omittedByteCount, producerTruncationMethod: artifact.truncationMethod,
        logProvenance: provenance.value
      },
      // The same validated facts, kept together as the ONE object the capsule
      // is built from -- so no later caller has to (or gets to) re-assemble
      // them from a row plus a buffer.
      log: {
        artifactId: artifact.id, relativePath: artifact.relativePath, rawBytesHash,
        validatedIncludedBytes: content, validatedText: decoded.text, parsedRecords: records.records,
        logProvenance: provenance.value, producerTruncated,
        producerOriginalByteCount: artifact.originalByteCount,
        producerOmittedByteCount: artifact.omittedByteCount, producerTruncationMethod: artifact.truncationMethod
      }
    };
  }

  if (artifact.schemaVersion !== EVIDENCE_ARTIFACT_SCHEMA_VERSION) {
    return { ok: false, reason: `${label} records evidence artifact schema version ${JSON.stringify(artifact.schemaVersion)}, which this build does not support (expected ${EVIDENCE_ARTIFACT_SCHEMA_VERSION}).` };
  }
  const parsed = parseEvidenceArtifact(category, decoded.text, label);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };

  return {
    ok: true,
    part: {
      category, artifactId: artifact.id, relativePath: artifact.relativePath,
      schemaVersion: artifact.schemaVersion, rawBytesHash,
      semanticHash: semanticEvidenceHash(parsed.artifact),
      originalRawByteCount: artifact.originalByteCount,
      parsedCanonicalValue: canonicalEvidenceSemantics(parsed.artifact),
      parsed: parsed.artifact,
      decodedText: decoded.text,
      producerTruncated: producerTruncated || isProvenanceIncomplete(parsed.artifact.value.truncation),
      producerOmittedByteCount: artifact.omittedByteCount + parsed.artifact.value.truncation.omittedByteCount,
      producerTruncationMethod: parsed.artifact.value.truncation.truncationMethod !== "NONE" ? parsed.artifact.value.truncation.truncationMethod : artifact.truncationMethod
    }
  };
}

/**
 * The evidence categories an AUTHORITATIVE review requires real,
 * byte-validated, schema-parsed content for. PATCH and CHANGED_FILES are
 * CONDITIONALLY required -- see `checkConditionalEvidenceRequirements`.
 */
export const REQUIRED_ARTIFACT_TYPES_FOR_AUTHORITATIVE_REVIEW: readonly string[] = Object.freeze(["FINAL_GIT", "PATCH", "VERIFICATION", "LOG", "CHANGED_FILES"]);

/** Categories whose producer truncation blocks an AUTHORITATIVE review outright; LOG follows its explicit optional/truncatable policy instead. */
const PRODUCER_TRUNCATION_BLOCKS: ReadonlySet<string> = Object.freeze(new Set(["FINAL_GIT", "PATCH", "CHANGED_FILES", "VERIFICATION"]));

export type EvidenceCheck = { ok: true } | { ok: false; reason: string };

/**
 * A critical artifact the producer could not persist in full can never
 * authorize an AUTHORITATIVE review. The reviewer must not attempt to
 * reconstruct the missing source content from anywhere else -- there is no
 * fallback path, only a block.
 */
export function assertProducerTruncationPolicy(parts: readonly ValidatedReviewEvidencePart[]): EvidenceCheck {
  for (const part of parts) {
    if (!PRODUCER_TRUNCATION_BLOCKS.has(part.category)) continue;
    if (part.producerTruncated) {
      return {
        ok: false,
        reason: `The execution writer persisted incomplete ${part.category} evidence (${part.producerOmittedByteCount} byte(s) omitted, method ${part.producerTruncationMethod}); an AUTHORITATIVE review cannot proceed on partial critical evidence.`
      };
    }
  }
  return { ok: true };
}

/**
 * PATCH and CHANGED_FILES are required based on what the Git evidence itself
 * says, not skipped by default:
 *   - a run that changed nothing still needs an explicit, valid, EMPTY
 *     CHANGED_FILES artifact -- absence is never read as emptiness;
 *   - a run that changed one or more files needs BOTH artifacts, every
 *     changed file represented in CHANGED_FILES, and every changed file
 *     either covered by the patch or carrying an explicit, policy-approved
 *     omission reason.
 */
export function checkConditionalEvidenceRequirements(parts: readonly ValidatedReviewEvidencePart[]): EvidenceCheck {
  const finalGit = parts.find(part => part.category === "FINAL_GIT");
  if (!finalGit || finalGit.parsed?.category !== "FINAL_GIT") {
    return { ok: false, reason: "Final Git evidence is missing from the validated artifact set; an AUTHORITATIVE review cannot proceed without it." };
  }
  const changedFilesPart = parts.find(part => part.category === "CHANGED_FILES");
  if (!changedFilesPart || changedFilesPart.parsed?.category !== "CHANGED_FILES") {
    return { ok: false, reason: "A changed-file artifact is required for every AUTHORITATIVE review, including a run that changed nothing (which must record an explicit empty change set)." };
  }

  const gitChanged = finalGit.parsed.value.changedFiles;
  const listed = changedFilesPart.parsed.value.files;
  const gitPaths = new Set(gitChanged.map(file => file.path.replace(/\\/g, "/")));
  const listedByPath = new Map(listed.map(file => [file.path.replace(/\\/g, "/"), file]));

  for (const path of gitPaths) {
    if (!listedByPath.has(path)) {
      return { ok: false, reason: `Changed file '${path}' appears in the final Git evidence but not in the changed-file artifact; the two disagree and this review cannot proceed.` };
    }
  }
  for (const [path, file] of listedByPath) {
    if (!gitPaths.has(path)) {
      return { ok: false, reason: `Changed file '${path}' appears in the changed-file artifact but not in the final Git evidence; the two disagree and this review cannot proceed.` };
    }
    const gitEntry = gitChanged.find(entry => entry.path.replace(/\\/g, "/") === path)!;
    if (gitEntry.status !== file.status) {
      return { ok: false, reason: `Changed file '${path}' has conflicting statuses ('${gitEntry.status}' in Git evidence, '${file.status}' in the changed-file artifact); this review cannot proceed.` };
    }
  }

  if (gitPaths.size === 0) return { ok: true };

  const patch = parts.find(part => part.category === "PATCH" && part.parsed?.category === "PATCH" && part.parsed.value.patchKind === "FINAL");
  if (!patch || patch.parsed?.category !== "PATCH") {
    return { ok: false, reason: `The final Git evidence records ${gitPaths.size} changed file(s), so a final patch artifact is required; none was present in the validated artifact set.` };
  }
  // Coverage is re-derived HERE from the diff's own file headers, rather than
  // trusted from the artifact's `coveredPaths` list: the list is a producer
  // claim, and the headers are the evidence. (The PATCH schema independently
  // refuses a `coveredPaths` entry no header names, so the two can never
  // disagree silently -- this is the second, independent proof.)
  const parsedDiff = parseRelayPatchPreview(patch.parsed.value.unifiedDiff);
  if (!parsedDiff.ok) {
    return { ok: false, reason: `The final patch artifact's unified diff cannot be parsed, so it evidences no changed file (${parsedDiff.reason}); this review cannot proceed on unparseable diff evidence.` };
  }
  const covered = new Set(parsedDiff.paths);
  const declared = new Set(patch.parsed.value.coveredPaths.map(entry => entry.replace(/\\/g, "/")));
  const omitted = new Map(patch.parsed.value.omittedPaths.map(entry => [entry.path.replace(/\\/g, "/"), entry.reason]));
  for (const path of gitPaths) {
    if (omitted.has(path)) continue;
    if (!covered.has(path)) {
      return { ok: false, reason: `Changed file '${path}' has no file header in the final patch's unified diff and carries no explicit policy-approved omission reason; a path appearing only inside another file's diff content is not coverage, and this review cannot proceed on incomplete diff evidence.` };
    }
    if (!declared.has(path)) {
      return { ok: false, reason: `Changed file '${path}' is evidenced by the final patch's unified diff but is missing from its declared covered-path list; the artifact's own claims and its content disagree.` };
    }
  }
  return { ok: true };
}

export type RequiredArtifactsValidationResult =
  | { ok: true; parts: ValidatedReviewEvidencePart[]; log: ValidatedLogEvidencePart | null }
  | { ok: false; reason: string; code?: LogProvenanceArtifactMismatchCode };

/**
 * The producer provenance an AUTHORITATIVE review requires before any reviewer
 * process is started.
 *
 * A log with no provenance, empty provenance, or provenance the producer could
 * not vouch for (TRUNCATED_UNKNOWN) is not evidence about the run: it is an
 * unbounded claim that the transcript shown is the transcript that happened.
 * Every requirement here is checked against the REAL validated bytes and
 * records -- the provenance object and the artifact must describe each other,
 * in both directions, or the review fails closed with no invocation and no
 * verdict. (`schemaVersion`/`recordSchemaVersion` are literal-checked by
 * logProvenanceSchema itself at parse time, so an unversioned or
 * wrong-version object never reaches here.)
 */
export function assertAuthoritativeLogProvenance(log: ValidatedLogEvidencePart | null): EvidenceCheck | LogProvenanceCrossCheck {
  if (!log) {
    return { ok: false, reason: "No execution LOG evidence was validated for this session; an AUTHORITATIVE review cannot proceed without the producer's own log provenance." };
  }
  const label = `The execution LOG artifact ${log.artifactId}`;
  const provenance = log.logProvenance;
  if (!provenance) {
    return { ok: false, reason: `${label} carries no producer provenance; an AUTHORITATIVE review cannot proceed on a log whose producer never stated what the complete stream was.` };
  }
  if (provenance.captureCompleteness === "TRUNCATED_UNKNOWN") {
    return { ok: false, reason: `${label} reports UNKNOWN capture completeness; the producer cannot say what was lost, so this log cannot authorize an AUTHORITATIVE review.` };
  }
  if (provenance.fullRawContentHash === null) {
    return { ok: false, reason: `${label} declares known completeness but carries no complete-stream hash.` };
  }
  if (provenance.includedRawByteCount !== log.validatedIncludedBytes.byteLength) {
    return { ok: false, reason: `${label} declares ${provenance.includedRawByteCount} included byte(s) but holds ${log.validatedIncludedBytes.byteLength}.` };
  }
  if (provenance.includedContentHash !== log.rawBytesHash) {
    return { ok: false, reason: `${label} declares an included-content hash that does not match the exact validated bytes.` };
  }
  if (provenance.includedRawByteCount + provenance.omittedRawByteCount !== provenance.originalRawByteCount) {
    return { ok: false, reason: `${label} declares raw byte counts that do not add up (${provenance.includedRawByteCount} + ${provenance.omittedRawByteCount} != ${provenance.originalRawByteCount}).` };
  }
  // Defence in depth: the row/provenance agreement is proved at the byte-level
  // validation boundary (assertArtifactRowMatchesLogProvenance), which is where
  // a contradictory pair is rejected. It is re-proved here from the fields the
  // validated part carries, so a future caller that reaches this gate by some
  // other path still cannot authorize a review on two disagreeing accounts.
  if (provenance.producerTruncated !== log.producerTruncated) {
    return { ok: false, code: LOG_PROVENANCE_ARTIFACT_MISMATCH, reason: `${label} disagrees with its own artifact row about whether the producer truncated it.` };
  }
  if (provenance.originalRawByteCount !== log.producerOriginalByteCount) {
    return { ok: false, code: LOG_PROVENANCE_ARTIFACT_MISMATCH, reason: `${label} declares an original byte count (${provenance.originalRawByteCount}) that disagrees with its own artifact row (${log.producerOriginalByteCount}).` };
  }
  if (provenance.omittedRawByteCount !== log.producerOmittedByteCount) {
    return { ok: false, code: LOG_PROVENANCE_ARTIFACT_MISMATCH, reason: `${label} declares an omitted byte count (${provenance.omittedRawByteCount}) that disagrees with its own artifact row (${log.producerOmittedByteCount}).` };
  }
  if (provenance.truncationMethod !== log.producerTruncationMethod) {
    return { ok: false, code: LOG_PROVENANCE_ARTIFACT_MISMATCH, reason: `${label} declares truncation method ${provenance.truncationMethod} while its own artifact row records ${log.producerTruncationMethod}.` };
  }
  if (provenance.producerTruncated && (provenance.omittedRawByteCount <= 0 || provenance.truncationMethod === "NONE")) {
    return { ok: false, reason: `${label} reports producer truncation without truthful omitted-byte provenance (${provenance.omittedRawByteCount} byte(s) omitted, method ${provenance.truncationMethod}).` };
  }
  if (!provenance.producerTruncated && provenance.fullRawContentHash !== provenance.includedContentHash) {
    return { ok: false, reason: `${label} reports no producer truncation, yet its complete-stream hash differs from the hash of the bytes it included.` };
  }
  if (provenance.recordCountIncluded !== log.parsedRecords.length) {
    return { ok: false, reason: `${label} declares ${provenance.recordCountIncluded} included record(s) but validates to ${log.parsedRecords.length}.` };
  }
  if (provenance.recordCountOriginal === null) {
    return { ok: false, reason: `${label} declares known completeness but no original record count; the two cannot both be true.` };
  }
  if (provenance.recordCountOriginal < provenance.recordCountIncluded) {
    return { ok: false, reason: `${label} declares fewer original records (${provenance.recordCountOriginal}) than it included (${provenance.recordCountIncluded}).` };
  }
  if (!provenance.producerTruncated && provenance.recordCountOriginal !== provenance.recordCountIncluded) {
    return { ok: false, reason: `${label} reports no producer truncation, yet its original and included record counts differ (${provenance.recordCountOriginal} vs ${provenance.recordCountIncluded}).` };
  }
  return { ok: true };
}

/** Which evidence category an artifact row's type maps to, or null for a row that carries no reviewer-visible evidence contract (CAPSULE, BASELINE_GIT, baseline PATCH). */
function categoryFor(artifact: ArtifactRecord): EvidenceArtifactCategory | "LOG" | null {
  switch (artifact.artifactType) {
    case "FINAL_GIT": return "FINAL_GIT";
    case "CHANGED_FILES": return "CHANGED_FILES";
    case "VERIFICATION": return "VERIFICATION";
    case "LOG": return "LOG";
    case "PATCH": return "PATCH";
    default: return null;
  }
}

/**
 * Byte-validates every ExecutionArtifact row belonging to a session against
 * the real artifact store, decodes and parses each evidence-bearing artifact
 * through its strict versioned schema, and returns the resulting immutable
 * `ValidatedReviewEvidencePart` set.
 *
 * Every required type must be present and pass; PATCH/CHANGED_FILES presence
 * is then re-checked conditionally against what the Git evidence actually
 * says (see `checkConditionalEvidenceRequirements`, which the caller runs
 * against the returned parts). Never reads the live project or Relay
 * workspace as a fallback -- only the application-owned artifact store.
 */
export async function validateRequiredArtifacts(
  artifactsRoot: string,
  executionSessionId: string,
  artifacts: readonly ArtifactRecord[],
  requiredTypes: readonly string[] = REQUIRED_ARTIFACT_TYPES_FOR_AUTHORITATIVE_REVIEW
): Promise<RequiredArtifactsValidationResult> {
  const boundArtifactIds = new Set(artifacts.map(artifact => artifact.id));
  let log: ValidatedLogEvidencePart | null = null;
  const parts: ValidatedReviewEvidencePart[] = [];
  for (const artifact of artifacts) {
    const result = await validateExecutionArtifact(artifactsRoot, executionSessionId, boundArtifactIds, artifact);
    if (!result.ok) return result;
    const category = categoryFor(artifact);
    if (!category) continue;
    const part = buildEvidencePart(artifact, result.content, category);
    if (!part.ok) return part;
    if (part.log) {
      // Two LOG artifacts make "the producer's provenance for this run"
      // ambiguous -- and an ambiguous authority is no authority. Refused
      // rather than resolved by ordering.
      if (log) return { ok: false, reason: `This execution session records more than one LOG artifact (${log.artifactId} and ${part.log.artifactId}); which log's producer provenance is authoritative is ambiguous and this review cannot proceed.` };
      log = part.log;
    }
    // The baseline patch is retained for context but is never the reviewable
    // delta; it is excluded from the authoritative part set so it can never
    // stand in for a missing final patch.
    if (part.part.parsed?.category === "PATCH" && part.part.parsed.value.patchKind === "BASELINE") continue;
    parts.push(part.part);
  }
  const presentTypes = new Set(parts.map(part => part.category));
  for (const requiredType of requiredTypes) {
    // PATCH/CHANGED_FILES presence is decided by the Git evidence itself, not
    // by an unconditional presence list -- see checkConditionalEvidenceRequirements.
    if (requiredType === "PATCH" || requiredType === "CHANGED_FILES") continue;
    if (!presentTypes.has(requiredType as EvidenceArtifactCategory | "LOG")) {
      return { ok: false, reason: `Required execution artifact of type ${requiredType} is missing for this execution session.` };
    }
  }
  return { ok: true, parts, log };
}

/** Stable identity of the exact validated evidence set a request was bound to. */
export function validatedEvidenceSetHash(parts: readonly ValidatedReviewEvidencePart[]): string {
  const identities = [...parts]
    .map(part => ({ category: part.category, artifactId: part.artifactId, rawBytesHash: part.rawBytesHash, semanticHash: part.semanticHash }))
    .sort((left, right) => `${left.category}:${left.artifactId}`.localeCompare(`${right.category}:${right.artifactId}`));
  return createHash("sha256").update(JSON.stringify(identities), "utf8").digest("hex");
}
