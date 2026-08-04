import type {
  ClaudeReviewerConfig,
  FakeReviewerScenario,
  ReviewerCapabilityDiagnostic,
  ReviewerDescriptor,
  ReviewerInvocationRecord,
  StructuredReviewVerdict
} from "@project-relay/relay-v2-domain";
import type { PromptAccounting, ReviewMaterialEnvelope, ReviewMaterialLedger } from "@project-relay/relay-v2-domain";
import type { ReviewInputCapsule } from "./review-binding.js";

export type ReviewerValidationRequest = {
  reviewRequestId: string;
  executionSessionId: string;
  reviewerConfig: Record<string, unknown>;
};

export type ReviewerValidationResult = { valid: true } | { valid: false; reason: string };

/**
 * Everything a reviewer is permitted to see: exactly the persisted, hash-bound
 * ReviewInputCapsule, plus (for fake-reviewer only) the separately-frozen
 * scenario config, plus (for claude-cli only) its own bound reviewer config.
 * Read-only: reviewers never receive a workspace path, process handle, or
 * credential of any kind. A reviewer must never be handed any additional
 * task/execution field assembled outside this capsule.
 */
export type ImmutableReviewCapsule = ReviewInputCapsule & {
  requestHash: string;
  /** Already-verified components of requestHash, exposed so a reviewer that binds its own material/prompt hash (claude-cli) never has to recompute or re-derive them itself. */
  reviewInputHash: string;
  reviewerConfigHash: string;
  scenario?: FakeReviewerScenario;
  claudeReviewerConfig?: ClaudeReviewerConfig;
};

export type ProcessStartInfo = { pid: number; processIdentity: string; startedAt: string };

/**
 * The exact transmitted material, built once by ReviewEngine before any
 * process exists. Reviewer-agnostic: it is the evidence envelope and its
 * accounting, with nothing reviewer-specific in it.
 */
export type PreparedReviewMaterial = {
  materialEnvelopeVersion: string;
  materialBudgetPolicyVersion: string;
  envelope: ReviewMaterialEnvelope;
  /** The ONE canonical serialization -- the exact bytes that will be sent. */
  materialCanonicalJson: string;
  materialByteCount: number;
  /** SHA-256 over `materialCanonicalJson`'s exact UTF-8 bytes. */
  materialHash: string;
  ledger: ReviewMaterialLedger;
  ledgerJson: string;
  ledgerHash: string;
};

/**
 * The reviewer-specific half of one immutable preparation: the exact policy
 * header, prompt, and stdin, each built ONCE and measured from the string that
 * was built -- never rebuilt after being measured, and never hashed over one
 * representation while a different one is sent.
 */
export type PreparedReviewerInvocation = {
  promptPolicyVersion: string;
  policyPrompt: string;
  policyPromptByteCount: number;
  finalPrompt: string;
  finalPromptByteCount: number;
  finalStdin: string;
  finalStdinByteCount: number;
  promptHash: string;
  finalStdinHash: string;
  promptAccounting: PromptAccounting;
};

/**
 * Everything about one invocation that is fixed BEFORE the process is created,
 * persisted on the PREPARING ReviewInvocation row, handed to the reviewer to
 * send verbatim, and independently rebuilt and compared at finalization.
 */
export type PreparedReviewInvocation = PreparedReviewMaterial & PreparedReviewerInvocation;

export type ReviewControls = {
  signal: AbortSignal;
  now(): Date;
  sleep(milliseconds: number): Promise<void>;
  /**
   * The immutable preparation ReviewEngine built and DURABLY PERSISTED before
   * this call. A reviewer that spawns a process must send exactly these bytes
   * and must never rebuild them: the identities on the PREPARING row already
   * describe this exact prompt and stdin, and finalization refuses any verdict
   * whose reconstruction disagrees with them. Absent only for a reviewer that
   * prepares no material (FakeReviewer).
   */
  prepared?: PreparedReviewInvocation;
  /**
   * Lets a reviewer report a durable, append-only forensic record of one real
   * process invocation without ever touching a database itself — ReviewEngine
   * is the only writer. Optional: FakeReviewer never calls it.
   */
  recordInvocation?(record: ReviewerInvocationRecord): Promise<void>;
  /**
   * Reports that the reviewer's own owned process has actually started (the
   * process runner's "started" event), letting ReviewEngine CAS-transition
   * the durable ReviewInvocation row from PREPARING to RUNNING under the
   * exact ownership/lease generation it was created with, and persist the
   * real process identity. A reviewer that spawns a real process (claude-cli)
   * must call this before processing any further output from that process
   * and must treat `{ ok: false }` as ownership loss: ReviewEngine has
   * already aborted the shared AbortSignal in that case, so the reviewer's
   * own process-running loop will observe the process being terminated on
   * its own — nothing else needs to be done at the call site beyond not
   * treating subsequent output as authoritative. Optional: FakeReviewer never
   * calls it, and a reviewer that never reaches this point (e.g. a pre-spawn
   * capability mismatch) leaves the invocation in PREPARING, which remains a
   * valid state for a terminal FAILED/ERROR write.
   */
  markInvocationRunning?(processInfo: ProcessStartInfo): Promise<{ ok: boolean }>;
};

export type ReviewerHealth = {
  healthy: boolean;
  checkedAt: string;
  message: string;
};

export interface RelayReviewer {
  readonly id: string;
  describe(): ReviewerDescriptor;
  validate(request: ReviewerValidationRequest): Promise<ReviewerValidationResult>;
  review(capsule: ImmutableReviewCapsule, controls: ReviewControls): Promise<StructuredReviewVerdict>;
  cancel?(reviewRequestId: string): Promise<void>;
  health(): Promise<ReviewerHealth>;
  /** Optional: a local-CLI reviewer that supports capability re-discovery (mirrors RelayExecutor.refreshCapabilities). ReviewEngine persists whatever this returns; FakeReviewer has no need to implement it. */
  refreshCapabilities?(): Promise<ReviewerCapabilityDiagnostic>;
  /**
   * The reviewer's own fixed policy header, exposed so ReviewEngine can charge
   * its exact bytes to the REVIEWER_POLICY_PROMPT budget category when it
   * builds the material byte ledger. A reviewer that sends no policy header
   * (FakeReviewer) simply does not implement this, and is charged nothing --
   * which is then a measured zero rather than an unmeasured one.
   */
  materialPolicyPrompt?(): string;
  /**
   * Builds this reviewer's exact prompt and stdin from the already-immutable
   * material envelope, ONCE, before ReviewEngine persists the invocation
   * identity and before any process is created. Pure and synchronous on
   * purpose: it must be reproducible bit-for-bit at finalization from the same
   * inputs, with no clock, no I/O, and no randomness. A reviewer that spawns
   * no process (FakeReviewer) does not implement it.
   *
   * Throwing here means the request cannot be reviewed at all -- no invocation
   * row is created and no process is started.
   */
  prepareInvocation?(capsule: ImmutableReviewCapsule, material: PreparedReviewMaterial): PreparedReviewerInvocation;
}
