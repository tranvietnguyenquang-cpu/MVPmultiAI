import {
  MATERIAL_BUDGET_POLICY_VERSION, REVIEW_MATERIAL_ENVELOPE_VERSION, canonicalJson,
  type ReviewMaterialLedger
} from "@project-relay/relay-v2-domain";
import { checkAuthoritativeMaterialPolicy, type ReviewInputCapsule } from "./review-binding.js";
import type {
  ImmutableReviewCapsule, PreparedReviewInvocation, PreparedReviewMaterial, RelayReviewer
} from "./reviewer-contract.js";

/**
 * The single construction path for an authoritative invocation's complete
 * transmitted identity.
 *
 * It exists so the same code runs in all three places that must agree exactly:
 * pre-spawn (where the identity is computed and persisted), inside the
 * reviewer (which sends the prepared bytes verbatim), and at finalization
 * (where the engine rebuilds everything independently and requires equality).
 * Three hand-written reconstructions of "the same" value is how a
 * reconstruction check quietly becomes a check that two different code paths
 * happen to agree today.
 */

export type PreparationResult =
  | { ok: true; prepared: PreparedReviewInvocation }
  | { ok: false; reason: string };

export type PreparationInputs = {
  capsule: ReviewInputCapsule;
  /** Already-verified request identity; becomes `core.reviewedRequestHash`. */
  requestHash: string;
  reviewInputHash: string;
  reviewerConfigHash: string;
  reviewer: RelayReviewer;
  /** The reviewer's own bound configuration, for reviewers that take one. */
  reviewerConfig: unknown;
};

/**
 * Builds the complete immutable preparation: the material envelope, its exact
 * ledger, and the reviewer's exact prompt and stdin -- every value built once,
 * measured from the string that was built, and never rebuilt afterwards.
 */
export function prepareReviewInvocation(inputs: PreparationInputs): PreparationResult {
  const policyPrompt = inputs.reviewer.materialPolicyPrompt?.() ?? "";
  const policy = checkAuthoritativeMaterialPolicy(inputs.capsule, policyPrompt, inputs.requestHash);
  if (!policy.ok) return policy;

  const ledger: ReviewMaterialLedger = policy.ledger;
  const material: PreparedReviewMaterial = {
    materialEnvelopeVersion: REVIEW_MATERIAL_ENVELOPE_VERSION,
    materialBudgetPolicyVersion: MATERIAL_BUDGET_POLICY_VERSION,
    envelope: policy.sections.envelope,
    materialCanonicalJson: policy.sections.envelopeJson,
    materialByteCount: policy.sections.envelopeByteCount,
    materialHash: policy.sections.materialHash,
    ledger,
    ledgerJson: canonicalJson(ledger),
    ledgerHash: policy.ledgerHash
  };

  if (!inputs.reviewer.prepareInvocation) {
    return { ok: false, reason: `Reviewer '${inputs.reviewer.id}' cannot prepare an authoritative invocation: it does not build a bound prompt, so no verdict of its could be tied to exact transmitted bytes.` };
  }

  const capsule: ImmutableReviewCapsule = {
    ...inputs.capsule,
    requestHash: inputs.requestHash,
    reviewInputHash: inputs.reviewInputHash,
    reviewerConfigHash: inputs.reviewerConfigHash
  };
  try {
    return { ok: true, prepared: { ...material, ...inputs.reviewer.prepareInvocation(capsule, material) } };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "The reviewer could not prepare an invocation for this review." };
  }
}

/** The exact identity fields a PREPARING invocation row commits to, and that finalization re-proves one by one. */
export type PreparedInvocationIdentity = {
  materialEnvelopeVersion: string;
  materialBudgetPolicyVersion: string;
  materialBudgetLedgerJson: string;
  materialBudgetLedgerHash: string;
  reviewMaterialHash: string;
  exactMaterialEnvelopeByteCount: number;
  promptPolicyVersion: string;
  promptHash: string;
  finalPromptByteCount: number;
  finalStdinHash: string;
  finalStdinByteCount: number;
};

export function preparedInvocationIdentity(prepared: PreparedReviewInvocation): PreparedInvocationIdentity {
  return {
    materialEnvelopeVersion: prepared.materialEnvelopeVersion,
    materialBudgetPolicyVersion: prepared.materialBudgetPolicyVersion,
    materialBudgetLedgerJson: prepared.ledgerJson,
    materialBudgetLedgerHash: prepared.ledgerHash,
    reviewMaterialHash: prepared.materialHash,
    exactMaterialEnvelopeByteCount: prepared.materialByteCount,
    promptPolicyVersion: prepared.promptPolicyVersion,
    promptHash: prepared.promptHash,
    finalPromptByteCount: prepared.finalPromptByteCount,
    finalStdinHash: prepared.finalStdinHash,
    finalStdinByteCount: prepared.finalStdinByteCount
  };
}

/**
 * Compares a freshly rebuilt identity against the one a PREPARING row
 * committed to, field by field, and names the FIRST field that differs.
 *
 * Field-by-field rather than one hash over the whole thing: "something about
 * this invocation changed" is not an actionable finding, and the field that
 * moved is exactly what distinguishes a tampered ledger from a tampered
 * prompt. A row that never bound a value (empty/zero) is reported as a
 * missing binding rather than as a match.
 */
export function compareInvocationIdentity(
  rebuilt: PreparedInvocationIdentity, persisted: Partial<PreparedInvocationIdentity>
): { ok: true } | { ok: false; field: string; reason: string } {
  const checks: ReadonlyArray<readonly [keyof PreparedInvocationIdentity, string]> = [
    ["materialEnvelopeVersion", "material envelope version"],
    ["materialBudgetPolicyVersion", "material budget policy version"],
    ["materialBudgetLedgerJson", "material byte ledger"],
    ["materialBudgetLedgerHash", "material byte ledger hash"],
    ["reviewMaterialHash", "review material hash"],
    ["exactMaterialEnvelopeByteCount", "exact material envelope byte count"],
    ["promptPolicyVersion", "prompt policy version"],
    ["promptHash", "prompt hash"],
    ["finalPromptByteCount", "final prompt byte count"],
    ["finalStdinHash", "final stdin hash"],
    ["finalStdinByteCount", "final stdin byte count"]
  ];
  for (const [field, label] of checks) {
    const persistedValue = persisted[field];
    if (persistedValue === undefined || persistedValue === "" || persistedValue === 0 || persistedValue === "{}") {
      return { ok: false, field, reason: `The reviewer invocation never bound a ${label}, so its output cannot be tied to any specific transmitted bytes.` };
    }
    if (persistedValue !== rebuilt[field]) {
      return { ok: false, field, reason: `The independently reconstructed ${label} does not match the one this reviewer invocation was bound to before its process started.` };
    }
  }
  return { ok: true };
}
