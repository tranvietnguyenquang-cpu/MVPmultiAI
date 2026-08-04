import { z } from "zod";
import { canonicalJson } from "./handoff.js";
import { AUTHORITATIVE_REVIEW_MATERIAL_BUDGET, type AuthoritativeReviewMaterialCategory, type PromptAccounting } from "./review.js";
import { sha256OfText, utf8ByteLength } from "./text-safety.js";

/**
 * Exact, serialized byte accounting for everything an AUTHORITATIVE review
 * sends to a reviewer CLI.
 *
 * The accounting this replaces summed a hand-picked subset of capsule fields
 * with `Buffer.byteLength`, which under-counted every rendered byte that was
 * not one of those fields: task context, verification requirements,
 * per-verification summaries, the reviewer policy prompt (declared with a
 * limit and then counted as literally `0`), the manifest, and all JSON
 * framing -- property names, quotes, commas, brackets, and escaping. A
 * material could therefore pass a "500,000 byte" budget while emitting far
 * more than that to the process.
 *
 * Here, every section is measured by SERIALIZING it with the exact serializer
 * the real material uses and taking the UTF-8 length of that fragment. The
 * final prompt and the final stdin are measured once, from the actual strings
 * that will be written, after they are built.
 */

export const MATERIAL_BUDGET_POLICY_VERSION = "material-budget-policy-v1" as const;

export const materialLedgerSectionSchema = z.object({
  /** Which budget category this section's bytes are charged to. */
  category: z.string().min(1).max(64),
  /** Logical path of this section within the rendered material (e.g. `gitEvidence.diff.unifiedDiff`). */
  sectionId: z.string().min(1).max(200),
  /** Complete source size before any redaction or truncation. */
  originalBytes: z.number().int().min(0),
  /** Real content bytes actually rendered, excluding JSON framing and omission markers. */
  includedContentBytes: z.number().int().min(0),
  /** Exact UTF-8 size of this section's serialized JSON fragment, produced by the same serializer as the real material. */
  serializedBytes: z.number().int().min(0),
  /** Content bytes removed by secret redaction. */
  redactionOmittedBytes: z.number().int().min(0),
  /** Content bytes removed by truncation (producer-side or reviewer-side). */
  truncationOmittedBytes: z.number().int().min(0),
  /** `serializedBytes - includedContentBytes`: property names, quotes, commas, brackets, escaping, and any omission marker. Never negative. */
  framingOverheadBytes: z.number().int().min(0),
  /** How many distinct execution artifacts this section's content was sourced from. */
  artifactCount: z.number().int().min(0),
  /** Bytes in this section whose content hash also appears in another section -- charged in full to both, never deduplicated away. */
  duplicateContentBytes: z.number().int().min(0)
}).strict();
export type MaterialLedgerSection = z.infer<typeof materialLedgerSectionSchema>;

export const materialByteLedgerSchema = z.object({
  policyVersion: z.literal(MATERIAL_BUDGET_POLICY_VERSION),
  budgetVersion: z.string().min(1).max(64),
  sections: z.array(materialLedgerSectionSchema).max(500),
  totals: z.object({
    originalBytes: z.number().int().min(0),
    includedContentBytes: z.number().int().min(0),
    serializedBytes: z.number().int().min(0),
    redactionOmittedBytes: z.number().int().min(0),
    truncationOmittedBytes: z.number().int().min(0),
    framingOverheadBytes: z.number().int().min(0),
    artifactCount: z.number().int().min(0),
    duplicateContentBytes: z.number().int().min(0)
  }).strict()
}).strict();
export type MaterialByteLedger = z.infer<typeof materialByteLedgerSchema>;

/** One section's inputs, before totals are folded in. `serializedFragment` must be produced by the same serializer the real material uses. */
export type MaterialLedgerSectionInput = {
  category: AuthoritativeReviewMaterialCategory;
  sectionId: string;
  originalBytes: number;
  includedContentBytes: number;
  serializedFragment: string;
  redactionOmittedBytes?: number;
  truncationOmittedBytes?: number;
  artifactCount?: number;
  /** SHA-256 of this section's rendered content, used only to detect content duplicated across sections. */
  contentHash?: string;
};

/** Serializes a value with the exact serializer the rendered material uses, so a ledger fragment and the real material never disagree about size. */
export function serializeMaterialFragment(value: unknown): string {
  return canonicalJson(value);
}

/**
 * Builds the ledger from already-final section values. Every section must
 * already carry its FINAL redacted/truncated content -- this function never
 * transforms content, only measures it, so a caller cannot measure one value
 * and render another without the mismatch showing up as a hash difference.
 */
export function buildMaterialByteLedger(inputs: readonly MaterialLedgerSectionInput[]): MaterialByteLedger {
  const hashCounts = new Map<string, number>();
  for (const input of inputs) {
    if (input.contentHash) hashCounts.set(input.contentHash, (hashCounts.get(input.contentHash) ?? 0) + 1);
  }
  const sections: MaterialLedgerSection[] = inputs.map(input => {
    const serializedBytes = utf8ByteLength(input.serializedFragment);
    return {
      category: input.category,
      sectionId: input.sectionId,
      originalBytes: input.originalBytes,
      includedContentBytes: input.includedContentBytes,
      serializedBytes,
      redactionOmittedBytes: input.redactionOmittedBytes ?? 0,
      truncationOmittedBytes: input.truncationOmittedBytes ?? 0,
      framingOverheadBytes: Math.max(0, serializedBytes - input.includedContentBytes),
      artifactCount: input.artifactCount ?? 0,
      duplicateContentBytes: input.contentHash && (hashCounts.get(input.contentHash) ?? 0) > 1 ? input.includedContentBytes : 0
    };
  });
  const totals = sections.reduce((sum, section) => ({
    originalBytes: sum.originalBytes + section.originalBytes,
    includedContentBytes: sum.includedContentBytes + section.includedContentBytes,
    serializedBytes: sum.serializedBytes + section.serializedBytes,
    redactionOmittedBytes: sum.redactionOmittedBytes + section.redactionOmittedBytes,
    truncationOmittedBytes: sum.truncationOmittedBytes + section.truncationOmittedBytes,
    framingOverheadBytes: sum.framingOverheadBytes + section.framingOverheadBytes,
    artifactCount: sum.artifactCount + section.artifactCount,
    duplicateContentBytes: sum.duplicateContentBytes + section.duplicateContentBytes
  }), {
    originalBytes: 0, includedContentBytes: 0, serializedBytes: 0, redactionOmittedBytes: 0,
    truncationOmittedBytes: 0, framingOverheadBytes: 0, artifactCount: 0, duplicateContentBytes: 0
  });
  for (const value of Object.values(totals)) {
    if (!Number.isSafeInteger(value)) throw new Error("Material byte ledger total overflowed a safe integer; refusing to proceed.");
  }
  return materialByteLedgerSchema.parse({
    policyVersion: MATERIAL_BUDGET_POLICY_VERSION,
    budgetVersion: AUTHORITATIVE_REVIEW_MATERIAL_BUDGET.budgetVersion,
    sections,
    totals
  });
}

/** Canonical hash of a ledger, bound into the ReviewRequest and re-proved at finalization. */
export function materialByteLedgerHash(ledger: MaterialByteLedger): string {
  return sha256OfText(canonicalJson(ledger));
}

export type MaterialBudgetCheck = { ok: true } | { ok: false; reason: string };

/** Every per-artifact fact the artifact-count/size limits are checked against. */
export type LedgerArtifactFact = { relativePath: string; byteCount: number };

/**
 * Enforces every limit in AUTHORITATIVE_REVIEW_MATERIAL_BUDGET that the
 * ledger alone can decide: per-category content and original-byte caps, the
 * aggregate original-byte cap, the aggregate SERIALIZED cap, the artifact
 * count, and per-artifact size. `maxPromptBytes`/`maxFinalStdinBytes` are
 * enforced separately by `enforcePromptAccounting`, against the real rendered
 * strings.
 *
 * Per-category caps bound CONTENT bytes -- what a category is allowed to say.
 * The aggregate cap bounds SERIALIZED bytes -- what the process actually
 * receives, framing, property names, quotes, commas, brackets, escaping, and
 * omission markers all included. Splitting it this way means a category's own
 * limit stays a statement about evidence volume, while nothing that is
 * transmitted goes uncounted: every byte of the material belongs to exactly
 * one ledger row, and the two exact prompt/stdin ceilings backstop the whole
 * thing against the real strings.
 */
export function enforceMaterialByteLedger(ledger: MaterialByteLedger, artifacts: readonly LedgerArtifactFact[]): MaterialBudgetCheck {
  const budget = AUTHORITATIVE_REVIEW_MATERIAL_BUDGET;
  const perCategory = new Map<string, { content: number; original: number }>();
  for (const category of Object.keys(budget.categories)) perCategory.set(category, { content: 0, original: 0 });
  for (const section of ledger.sections) {
    const bucket = perCategory.get(section.category);
    if (!bucket) return { ok: false, reason: `Material byte ledger references unknown budget category '${section.category}'.` };
    bucket.content += section.includedContentBytes;
    bucket.original += section.originalBytes;
  }
  for (const [category, bucket] of perCategory) {
    const cap = budget.categories[category as AuthoritativeReviewMaterialCategory];
    if (bucket.content > cap.maxIncludedBytes) {
      return { ok: false, reason: `Evidence category ${category} renders ${bucket.content} content bytes, exceeding its material budget of ${cap.maxIncludedBytes} bytes.` };
    }
    if (bucket.original > cap.maxOriginalBytes) {
      return { ok: false, reason: `Evidence category ${category} has ${bucket.original} original bytes, exceeding its original-byte budget of ${cap.maxOriginalBytes} bytes.` };
    }
  }
  if (ledger.totals.originalBytes > budget.maxTotalOriginalBytes) {
    return { ok: false, reason: `Total original review evidence (${ledger.totals.originalBytes} bytes) exceeds the aggregate original-byte budget of ${budget.maxTotalOriginalBytes} bytes.` };
  }
  if (ledger.totals.serializedBytes > budget.maxTotalIncludedBytes) {
    return { ok: false, reason: `Total serialized review material (${ledger.totals.serializedBytes} bytes) exceeds the aggregate material budget of ${budget.maxTotalIncludedBytes} bytes.` };
  }
  if (artifacts.length > budget.maxArtifactCount) {
    return { ok: false, reason: `Execution artifact manifest has ${artifacts.length} entries, exceeding the maximum of ${budget.maxArtifactCount}.` };
  }
  for (const artifact of artifacts) {
    if (artifact.byteCount > budget.maxBytesPerArtifact) {
      return { ok: false, reason: `Artifact ${artifact.relativePath} (${artifact.byteCount} bytes) exceeds the maximum per-artifact size of ${budget.maxBytesPerArtifact} bytes.` };
    }
  }
  return { ok: true };
}

/**
 * Enforces the two ceilings that apply to the real rendered strings.
 * `maxPromptBytes` is checked independently of `maxFinalStdinBytes`: a prompt
 * of `maxPromptBytes + 1` must be rejected even though it is still far below
 * the stdin cap, because the prompt cap is the one that bounds what the model
 * is actually asked to read.
 */
export function enforcePromptAccounting(accounting: PromptAccounting): MaterialBudgetCheck {
  const budget = AUTHORITATIVE_REVIEW_MATERIAL_BUDGET;
  if (accounting.finalPromptBytes > budget.maxPromptBytes) {
    return { ok: false, reason: `Final rendered review prompt (${accounting.finalPromptBytes} bytes) exceeds the maximum prompt size of ${budget.maxPromptBytes} bytes; the request cannot be reviewed authoritatively.` };
  }
  if (accounting.finalStdinBytes > budget.maxFinalStdinBytes) {
    return { ok: false, reason: `Final reviewer stdin (${accounting.finalStdinBytes} bytes) exceeds the maximum stdin size of ${budget.maxFinalStdinBytes} bytes; the request cannot be reviewed authoritatively.` };
  }
  return { ok: true };
}
