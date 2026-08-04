import { z } from "zod";
import { canonicalJson } from "./handoff.js";
import { logProvenanceSchema } from "./log-records.js";
import { MATERIAL_BUDGET_POLICY_VERSION, materialLedgerSectionSchema } from "./material-ledger.js";
import { AUTHORITATIVE_REVIEW_MATERIAL_BUDGET, reviewMaterialManifestSchema } from "./review.js";
import { streamCaptureProvenanceSchema } from "./stream-capture.js";
import { sha256OfText, utf8ByteLength } from "./text-safety.js";

/**
 * The EXACT structure transmitted to an authoritative reviewer, versioned.
 *
 * The accounting this replaces measured a sum of separately serialized
 * fragments and then sent a DIFFERENT object: the real transmission added
 * outer object framing, nested framing, property names, separators, escaping,
 * `requestHash`, the manifest, and the provenance disclosure -- none of which
 * the ledger had measured, and two of which (manifest, provenance) the
 * reviewer could not even see, because they were hashed into the binding but
 * never placed inside the material. A budget that measures one object while a
 * different object is transmitted proves nothing about what was transmitted.
 *
 * Here there is exactly one transmitted value, `ReviewMaterialEnvelopeV1`, and
 * its exact canonical UTF-8 bytes are what gets measured, capped, hashed, and
 * written to the reviewer's stdin. The manifest, the provenance disclosure,
 * and the ledger are all INSIDE it, so the reviewer sees the same accounting
 * the engine enforced.
 *
 * ## Why the ledger is not self-referential
 *
 * A ledger that included its own serialized size (or its own hash) could not
 * be built: writing the value changes the value. So the construction is
 * strictly ordered and one-directional:
 *
 *   1. build and canonicalize `core` (every section, manifest, provenance);
 *   2. build `ledger` by MEASURING that exact canonical core;
 *   3. assemble `{ schemaVersion, core, ledger }` from the now-immutable parts;
 *   4. canonicalize the whole envelope ONCE and measure those exact bytes.
 *
 * The envelope's own total is therefore never stored inside the ledger. It is
 * persisted alongside it as `exactMaterialEnvelopeByteCount`, and it is the
 * value `maxTotalIncludedBytes` is enforced against.
 */

export const REVIEW_MATERIAL_ENVELOPE_VERSION = "review-material-envelope-v1" as const;
export const REVIEW_MATERIAL_CORE_VERSION = "review-material-core-v1" as const;
export const REVIEW_MATERIAL_LEDGER_VERSION = "review-material-ledger-v1" as const;

const sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/);

/**
 * Everything a reviewer is shown about how its evidence was captured, stated
 * in the material itself rather than only in a binding it cannot read.
 */
export const provenanceDisclosureSchema = z.object({
  schemaVersion: z.literal("review-provenance-disclosure-v1"),
  /** Per-verification-operation stream capture provenance, including any output lost above the execution engine. */
  verificationStreams: z.array(z.object({
    operation: z.string().min(1).max(100),
    runnerOutputTruncated: z.boolean(),
    runnerStdoutBytes: z.number().int().min(0),
    runnerStderrBytes: z.number().int().min(0),
    stdout: streamCaptureProvenanceSchema,
    stderr: streamCaptureProvenanceSchema
  }).strict()).max(10),
  /** The producer's own LOG provenance, carried through unchanged. */
  executionLog: logProvenanceSchema.nullable(),
  /** True when any evidence in this material could not be proven complete. */
  anyIncompleteEvidence: z.boolean()
}).strict();
export type ProvenanceDisclosure = z.infer<typeof provenanceDisclosureSchema>;

/**
 * The reviewed content itself. Deliberately NOT self-referential: it carries
 * `reviewedRequestHash` (an identity computed before it existed) but never its
 * own hash or its own size.
 */
export const reviewMaterialCoreSchema = z.object({
  schemaVersion: z.literal(REVIEW_MATERIAL_CORE_VERSION),
  reviewedRequestHash: sha256HexSchema,
  approvedSpecification: z.record(z.unknown()),
  gitEvidence: z.record(z.unknown()),
  patchEvidence: z.record(z.unknown()),
  changedFileEvidence: z.record(z.unknown()),
  verificationEvidence: z.record(z.unknown()),
  executionLogEvidence: z.record(z.unknown()),
  executionSummary: z.record(z.unknown()),
  evidenceManifest: reviewMaterialManifestSchema,
  provenanceDisclosure: provenanceDisclosureSchema
}).strict();
export type ReviewMaterialCore = z.infer<typeof reviewMaterialCoreSchema>;

/**
 * The exact byte accounting of the core above. Every count is measured from
 * the canonical serialization of the value actually placed in the envelope.
 */
export const reviewMaterialLedgerSchema = z.object({
  schemaVersion: z.literal(REVIEW_MATERIAL_LEDGER_VERSION),
  policyVersion: z.literal(MATERIAL_BUDGET_POLICY_VERSION),
  budgetVersion: z.string().min(1).max(64),
  sectionEntries: z.array(materialLedgerSectionSchema).max(500),
  /** UTF-8 size of `canonicalJson(core)` -- the complete reviewed content, framing included. */
  coreCanonicalByteCount: z.number().int().min(0),
  /** UTF-8 size of `canonicalJson(core.evidenceManifest)`. */
  manifestByteCount: z.number().int().min(0),
  /** UTF-8 size of `canonicalJson(core.provenanceDisclosure)`. */
  provenanceByteCount: z.number().int().min(0),
  /**
   * `coreCanonicalByteCount` minus the sum of every section entry's
   * serialized size: the core's own outer object framing (top-level property
   * names, quotes, separators, braces). Stated exactly rather than
   * approximated or ignored, so the section rows and the measured whole are
   * reconciled instead of merely coexisting.
   */
  outerFramingByteCount: z.number().int().min(0),
  originalSourceByteCount: z.number().int().min(0),
  includedContentByteCount: z.number().int().min(0),
  redactionOmittedByteCount: z.number().int().min(0),
  truncationOmittedByteCount: z.number().int().min(0),
  artifactCount: z.number().int().min(0)
}).strict();
export type ReviewMaterialLedger = z.infer<typeof reviewMaterialLedgerSchema>;

export const reviewMaterialEnvelopeSchema = z.object({
  schemaVersion: z.literal(REVIEW_MATERIAL_ENVELOPE_VERSION),
  core: reviewMaterialCoreSchema,
  ledger: reviewMaterialLedgerSchema
}).strict();
export type ReviewMaterialEnvelope = z.infer<typeof reviewMaterialEnvelopeSchema>;

/** Canonical hash of a ledger, bound into the invocation and re-proved at finalization. */
export function reviewMaterialLedgerHash(ledger: ReviewMaterialLedger): string {
  return sha256OfText(canonicalJson(ledger));
}

/**
 * The exact canonical serialization of a complete envelope, and its exact
 * UTF-8 size. Called ONCE per envelope; the returned string is the one that is
 * hashed, budget-checked, and written to the reviewer's stdin -- there is no
 * second serialization anywhere that could differ from it.
 */
export function serializeReviewMaterialEnvelope(envelope: ReviewMaterialEnvelope): { json: string; byteCount: number; hash: string } {
  const json = canonicalJson(envelope);
  return { json, byteCount: utf8ByteLength(json), hash: sha256OfText(json) };
}

export type EnvelopeBudgetCheck = { ok: true } | { ok: false; reason: string };

/**
 * Enforces the aggregate transmitted-size ceiling against the EXACT bytes of
 * the complete canonical envelope -- outer framing, manifest, provenance
 * disclosure, and ledger all included, none of it approximated.
 */
export function enforceEnvelopeByteBudget(exactEnvelopeByteCount: number): EnvelopeBudgetCheck {
  const limit = AUTHORITATIVE_REVIEW_MATERIAL_BUDGET.maxTotalIncludedBytes;
  if (exactEnvelopeByteCount > limit) {
    return { ok: false, reason: `The exact canonical review material envelope (${exactEnvelopeByteCount} bytes) exceeds the aggregate material budget of ${limit} bytes; the request cannot be reviewed authoritatively.` };
  }
  return { ok: true };
}
