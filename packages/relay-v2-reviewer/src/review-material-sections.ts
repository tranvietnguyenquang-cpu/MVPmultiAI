import {
  AUTHORITATIVE_REVIEW_MATERIAL_BUDGET, boundTextToBytes, buildMaterialByteLedger, canonicalJson,
  MATERIAL_BUDGET_POLICY_VERSION, REVIEW_MATERIAL_CORE_VERSION, REVIEW_MATERIAL_ENVELOPE_VERSION,
  REVIEW_MATERIAL_LEDGER_VERSION, reviewMaterialCoreSchema, reviewMaterialEnvelopeSchema, reviewMaterialLedgerSchema,
  serializeMaterialFragment, serializeReviewMaterialEnvelope, sha256OfText, untruncatedText, utf8ByteLength,
  type AuthoritativeReviewMaterialCategory, type BoundedText, type MaterialByteLedger,
  type MaterialLedgerSectionInput, type ProvenanceDisclosure, type ReviewMaterialCore, type ReviewMaterialEnvelope,
  type ReviewMaterialLedger, type ReviewMaterialManifest, type TruncationMethod
} from "@project-relay/relay-v2-domain";
import { redactSecrets } from "@project-relay/local-safety";
import type { ReviewInputCapsule } from "./review-binding.js";

/**
 * The ONE decomposition of a review capsule into the material that is
 * transmitted, and the ONE measurement of it.
 *
 * Two defects shaped this module.
 *
 * The first: an accounting that measures one representation while the prompt
 * renders another proves nothing about the prompt. A handful of capsule fields
 * summed with `Buffer.byteLength` on one side, a separately assembled object
 * serialized into the prompt on the other, is exactly how whole fields (task
 * context, verification requirements, the reviewer policy prompt, the
 * manifest) and all JSON framing went uncounted.
 *
 * The second, which this pass fixes: even after the sections were measured
 * with the real serializer, the value actually SENT was a different object
 * again -- the sections wrapped in outer framing, with `requestHash` spliced
 * in, and with the manifest and the ledger hashed into the binding but never
 * placed inside the material at all. The reviewer could not see the accounting
 * it was being held to, and nothing measured the outer framing.
 *
 * So there is now exactly one transmitted value, `ReviewMaterialEnvelopeV1`,
 * built in a strict order: core, then ledger measured from that exact core,
 * then the envelope assembled from both immutable parts, then ONE canonical
 * serialization whose exact UTF-8 bytes are what gets capped, hashed, and
 * written to the reviewer's stdin. The ledger never contains its own size or
 * hash -- writing that value would change the value it describes.
 */

/** Full disclosure for one rendered text fragment. Every count is measured from the value actually rendered. */
export type RenderedEvidencePart = {
  sectionId: string;
  category: AuthoritativeReviewMaterialCategory;
  /** The execution artifact this fragment's content was proven from, when it has one. */
  sourceArtifactId: string | null;
  /** SHA-256 of the complete raw source text this fragment derives from, before redaction or truncation. */
  fullRawContentHash: string;
  originalByteCount: number;
  /** Real content bytes rendered, excluding any omission marker. */
  includedByteCount: number;
  /** Content bytes the reader never sees: redaction plus truncation. The marker is framing, so it never reduces this. */
  omittedByteCount: number;
  /** Measured size of the rendered fragment itself, omission marker included. */
  finalRenderedByteCount: number;
  truncationMethod: TruncationMethod;
  producerTruncated: boolean;
  reviewerTruncated: boolean;
  redactionApplied: boolean;
  redactedByteCount: number;
};

type RenderedText = { text: string; part: RenderedEvidencePart };

const DEFAULT_OMISSION_MARKER = "\n...[truncated by the review materializer]...\n";
const DIFF_OMISSION_MARKER = "\n...[diff truncated by the review materializer]...\n";

/**
 * Redacts, measures, truncates, and measures again -- in that order, because
 * redaction changes the byte count truncation must respect, and the omission
 * marker changes the byte count the manifest must declare.
 */
function renderText(options: {
  sectionId: string;
  category: AuthoritativeReviewMaterialCategory;
  original: string;
  sourceArtifactId?: string | null;
  producerTruncated?: boolean;
  /** When set, the redacted text is bounded to this many rendered bytes; otherwise it is rendered whole. */
  maxRenderedBytes?: number;
  truncationMethod?: Extract<TruncationMethod, "HEAD" | "TAIL" | "HEAD_AND_TAIL">;
  omissionMarker?: string;
}): RenderedText {
  const originalByteCount = utf8ByteLength(options.original);
  const redacted = redactSecrets(options.original);
  const redactionOmitted = Math.max(0, originalByteCount - utf8ByteLength(redacted));

  const bounded: BoundedText = options.maxRenderedBytes === undefined
    ? untruncatedText(redacted)
    : boundTextToBytes(redacted, options.maxRenderedBytes, options.truncationMethod ?? "HEAD", options.omissionMarker ?? DEFAULT_OMISSION_MARKER);

  return {
    text: bounded.text,
    part: {
      sectionId: options.sectionId,
      category: options.category,
      sourceArtifactId: options.sourceArtifactId ?? null,
      fullRawContentHash: sha256OfText(options.original),
      originalByteCount,
      includedByteCount: bounded.includedContentByteCount,
      omittedByteCount: redactionOmitted + bounded.omittedByteCount,
      finalRenderedByteCount: bounded.finalRenderedByteCount,
      truncationMethod: bounded.truncationMethod,
      producerTruncated: options.producerTruncated ?? false,
      reviewerTruncated: bounded.truncated,
      redactionApplied: redactionOmitted > 0,
      redactedByteCount: redactionOmitted
    }
  };
}

/** One structural section: a ledger row, and the exact value rendered at its logical path in the core. */
type StructuralSection = {
  sectionId: string;
  category: AuthoritativeReviewMaterialCategory;
  value: unknown;
  /** The text fragments rendered into this section, whose content bytes it is charged for. */
  texts: readonly RenderedText[];
  /** Execution artifacts this section's content was proven from, for sections that carry no text fragments of their own. */
  artifactIds?: readonly (string | null)[];
};

export type BuiltMaterialSections = {
  /** The exact transmitted structure: `{ schemaVersion, core, ledger }`. */
  envelope: ReviewMaterialEnvelope;
  /** The ONE canonical serialization of that envelope -- the exact bytes sent, measured, and hashed. */
  envelopeJson: string;
  envelopeByteCount: number;
  /** SHA-256 over `envelopeJson`'s exact UTF-8 bytes. */
  materialHash: string;
  core: ReviewMaterialCore;
  ledger: ReviewMaterialLedger;
  ledgerHash: string;
  /** The per-category ledger the pre-existing per-category/aggregate budget checks consume. */
  categoryLedger: MaterialByteLedger;
  manifest: ReviewMaterialManifest;
  parts: RenderedEvidencePart[];
};

/**
 * The artifact whose byte-validated content a category's evidence was proven
 * from. Sourced from the capsule's own hash-bound manifest, so the sections
 * built here are reproducible from the persisted capsule alone -- which is
 * what lets finalization reconstruct the identical ledger.
 */
function artifactIdFor(capsule: ReviewInputCapsule, artifactType: string): string | null {
  return capsule.executionArtifactManifest.find(artifact => artifact.artifactType === artifactType)?.artifactId ?? null;
}

/**
 * Builds every rendered section, the core, the manifest, the provenance
 * disclosure, the exact byte ledger, and the complete serialized envelope, in
 * one pass over the capsule.
 *
 * `policyPromptText` is the reviewer's own policy header. It is charged to the
 * REVIEWER_POLICY_PROMPT category with its exact canonical UTF-8 byte count
 * rather than being declared with a limit and then counted as literally zero,
 * which is what the original accounting did.
 */
export function buildReviewMaterialSections(
  capsule: ReviewInputCapsule, policyPromptText: string, reviewedRequestHash: string
): BuiltMaterialSections {
  const budget = AUTHORITATIVE_REVIEW_MATERIAL_BUDGET.categories;

  const patchArtifactId = artifactIdFor(capsule, "PATCH");
  const finalGitArtifactId = artifactIdFor(capsule, "FINAL_GIT");
  const changedFilesArtifactId = artifactIdFor(capsule, "CHANGED_FILES");
  const verificationArtifactId = artifactIdFor(capsule, "VERIFICATION");
  const logArtifactId = artifactIdFor(capsule, "LOG");

  // --- text fragments -----------------------------------------------------
  const title = renderText({ sectionId: "task.title", category: "APPROVED_SPEC", original: capsule.taskTitle });
  const objective = renderText({ sectionId: "task.objective", category: "APPROVED_SPEC", original: capsule.taskObjective });
  const context = renderText({ sectionId: "task.context", category: "APPROVED_SPEC", original: capsule.taskContext });
  const constraints = capsule.taskConstraints.map((value, index) => renderText({ sectionId: `task.constraints[${index}]`, category: "CONSTRAINTS", original: value }));
  const acceptanceCriteria = capsule.acceptanceCriteria.map((value, index) => renderText({ sectionId: `task.acceptanceCriteria[${index}]`, category: "ACCEPTANCE_CRITERIA", original: value }));
  const summary = renderText({ sectionId: "execution.summary", category: "EXECUTION_SUMMARY", original: capsule.executionSummary });
  const model = renderText({ sectionId: "execution.selectedModel", category: "EXECUTION_SUMMARY", original: capsule.approvedModel });

  const finalDiff = renderText({
    sectionId: "patchEvidence.unifiedDiff", category: "GIT_DIFF", original: capsule.finalGitEvidence.diffPreview,
    sourceArtifactId: patchArtifactId, producerTruncated: capsule.finalGitEvidence.diffTruncated,
    maxRenderedBytes: budget.GIT_DIFF.maxIncludedBytes, truncationMethod: "HEAD", omissionMarker: DIFF_OMISSION_MARKER
  });
  const baselineDiff = renderText({
    sectionId: "patchEvidence.baselineUnifiedDiff", category: "GIT_DIFF",
    original: capsule.baselineGitEvidence.dirty ? capsule.baselineGitEvidence.diffPreview : "",
    producerTruncated: capsule.baselineGitEvidence.diffTruncated,
    maxRenderedBytes: budget.GIT_DIFF.maxIncludedBytes, truncationMethod: "HEAD", omissionMarker: DIFF_OMISSION_MARKER
  });

  const verificationEntries = capsule.verificationEvidence.map((entry, index) => ({
    entry,
    operationSummary: renderText({ sectionId: `verification[${index}].summary`, category: "VERIFICATION_STDOUT", original: entry.summary, sourceArtifactId: verificationArtifactId }),
    stdout: renderText({ sectionId: `verification[${index}].stdout`, category: "VERIFICATION_STDOUT", original: entry.stdoutPreview, sourceArtifactId: verificationArtifactId, producerTruncated: entry.stdoutTruncated }),
    stderr: renderText({ sectionId: `verification[${index}].stderr`, category: "VERIFICATION_STDERR", original: entry.stderrPreview, sourceArtifactId: verificationArtifactId, producerTruncated: entry.stderrTruncated })
  }));

  const transcript = renderText({
    sectionId: "executionLog.transcript", category: "EXECUTION_LOG", original: capsule.executionLogEvidence.preview,
    sourceArtifactId: logArtifactId, producerTruncated: capsule.executionLogEvidence.producerTruncated
  });

  const policyPrompt = renderText({ sectionId: "reviewerPolicyPrompt", category: "REVIEWER_POLICY_PROMPT", original: policyPromptText });

  // --- provenance disclosure: what the reviewer is told about its evidence --
  const provenanceDisclosure: ProvenanceDisclosure = {
    schemaVersion: "review-provenance-disclosure-v1",
    verificationStreams: capsule.verificationEvidence.map(entry => ({
      operation: entry.operation,
      runnerOutputTruncated: entry.runnerOutputTruncated,
      runnerStdoutBytes: entry.runnerStdoutBytes,
      runnerStderrBytes: entry.runnerStderrBytes,
      stdout: entry.stdoutCapture,
      stderr: entry.stderrCapture
    })),
    executionLog: capsule.executionLogEvidence.producerProvenance,
    anyIncompleteEvidence:
      capsule.verificationEvidence.some(entry => entry.stdoutCapture.captureCompleteness !== "COMPLETE" || entry.stderrCapture.captureCompleteness !== "COMPLETE")
      || capsule.executionLogEvidence.anyTruncation
      || capsule.finalGitEvidence.diffTruncated
      || finalDiff.part.reviewerTruncated
  };

  // --- structural sections: together, exactly the core --------------------
  const sections: StructuralSection[] = [
    {
      sectionId: "identity", category: "EXECUTION_SUMMARY", texts: [],
      value: {
        reviewRequestId: capsule.reviewRequestId,
        reviewAuthority: capsule.reviewAuthority,
        reviewPolicyVersion: capsule.reviewPolicyVersion
      }
    },
    {
      sectionId: "approvedSpecification", category: "APPROVED_SPEC", texts: [title, objective, context],
      value: {
        title: title.text,
        objective: objective.text,
        context: context.text,
        specHash: capsule.taskSpecHash,
        verificationRequirements: capsule.approvedVerificationOperations,
        // The approved delivery policy, stated to the reviewer rather than
        // left implicit: which executor/model/effort and which reviewer this
        // work was authorized under is part of the specification it must be
        // judged against.
        executorReviewerPolicy: {
          selectedExecutor: capsule.approvedExecutorSelection,
          selectedEffort: capsule.approvedEffort,
          selectedReviewerPolicy: capsule.approvedReviewer,
          taskSelectedReviewer: capsule.taskSelectedReviewer
        }
      }
    },
    { sectionId: "approvedSpecification.constraints", category: "CONSTRAINTS", texts: constraints, value: constraints.map(item => item.text) },
    { sectionId: "approvedSpecification.acceptanceCriteria", category: "ACCEPTANCE_CRITERIA", texts: acceptanceCriteria, value: acceptanceCriteria.map(item => item.text) },
    {
      sectionId: "executionSummary", category: "EXECUTION_SUMMARY", texts: [summary, model],
      value: {
        executorId: capsule.executionExecutorId,
        selectedModel: model.text,
        status: capsule.executionStatus,
        resultStatus: capsule.executionResultStatus,
        summary: summary.text,
        summaryHash: capsule.executionSummaryHash,
        capsuleHash: capsule.executionCapsuleHash,
        finalBranch: capsule.finalBranch,
        finalHead: capsule.finalHead
      }
    },
    {
      sectionId: "gitEvidence", category: "CHANGED_FILE_METADATA", texts: [],
      artifactIds: [finalGitArtifactId],
      value: {
        baseline: {
          available: capsule.baselineGitEvidence.available, branch: capsule.baselineGitEvidence.branch,
          head: capsule.baselineGitEvidence.head, dirty: capsule.baselineGitEvidence.dirty
        },
        final: {
          available: capsule.finalGitEvidence.available, branch: capsule.finalGitEvidence.branch,
          head: capsule.finalGitEvidence.head, dirty: capsule.finalGitEvidence.dirty
        }
      }
    },
    {
      sectionId: "changedFileEvidence", category: "CHANGED_FILE_METADATA", texts: [],
      artifactIds: [changedFilesArtifactId],
      value: { changedFiles: capsule.finalGitEvidence.changedFiles }
    },
    {
      sectionId: "patchEvidence", category: "GIT_DIFF", texts: [finalDiff, baselineDiff],
      artifactIds: [patchArtifactId],
      value: {
        omittedForSensitivePaths: capsule.finalGitEvidence.diffOmittedForSensitivePaths || capsule.baselineGitEvidence.diffOmittedForSensitivePaths,
        truncated: capsule.finalGitEvidence.diffTruncated || capsule.baselineGitEvidence.diffTruncated,
        reviewerTruncated: finalDiff.part.reviewerTruncated || baselineDiff.part.reviewerTruncated,
        unifiedDiff: finalDiff.text,
        baselineUnifiedDiff: baselineDiff.text
      }
    },
    {
      sectionId: "verificationEvidence", category: "VERIFICATION_STDOUT",
      texts: verificationEntries.flatMap(item => [item.operationSummary, item.stdout]),
      value: {
        results: verificationEntries.map(item => ({
          operation: item.entry.operation,
          displayCommand: item.entry.displayCommand,
          passed: item.entry.passed,
          exitCode: item.entry.exitCode,
          timedOut: item.entry.timedOut,
          cancelled: item.entry.cancelled,
          summary: item.operationSummary.text,
          stdout: item.stdout.text,
          stdoutTruncated: item.entry.stdoutTruncated,
          stdoutCaptureCompleteness: item.entry.stdoutCapture.captureCompleteness,
          stderrCaptureCompleteness: item.entry.stderrCapture.captureCompleteness
        }))
      }
    },
    {
      sectionId: "verificationEvidence.stderr", category: "VERIFICATION_STDERR",
      texts: verificationEntries.map(item => item.stderr),
      value: verificationEntries.map(item => ({
        operation: item.entry.operation,
        stderr: item.stderr.text,
        stderrTruncated: item.entry.stderrTruncated
      }))
    },
    {
      sectionId: "executionLogEvidence", category: "EXECUTION_LOG", texts: [transcript],
      artifactIds: [logArtifactId],
      value: {
        available: capsule.executionLogEvidence.available,
        transcript: transcript.text,
        anyTruncation: capsule.executionLogEvidence.anyTruncation,
        // Stated to the reviewer as two separate accounts, exactly as they are
        // held: what the producer could persist, and what this materializer
        // then rendered. Neither number is allowed to stand in for the other.
        producerProvenance: capsule.executionLogEvidence.producerProvenance,
        producerTruncated: capsule.executionLogEvidence.producerTruncated,
        reviewerRendering: {
          sourceByteCount: capsule.executionLogEvidence.sourceByteCount,
          includedContentSha256: capsule.executionLogEvidence.includedContentSha256,
          reviewerTruncated: capsule.executionLogEvidence.reviewerTruncated,
          reviewerTruncationMethod: capsule.executionLogEvidence.reviewerTruncationMethod,
          reviewerIncludedByteCount: capsule.executionLogEvidence.reviewerIncludedByteCount,
          reviewerOmittedByteCount: capsule.executionLogEvidence.reviewerOmittedByteCount,
          reviewerMarkerByteCount: capsule.executionLogEvidence.reviewerMarkerByteCount,
          reviewerFinalRenderedByteCount: capsule.executionLogEvidence.reviewerFinalRenderedByteCount,
          reviewerRenderedSha256: capsule.executionLogEvidence.reviewerRenderedSha256,
          reviewerIncludedRecordCount: capsule.executionLogEvidence.reviewerIncludedRecordCount,
          reviewerOmittedRecordCount: capsule.executionLogEvidence.reviewerOmittedRecordCount
        }
      }
    },
    {
      sectionId: "evidenceIdentity", category: "ARTIFACT_MANIFEST", texts: [],
      value: {
        baselineGitEvidenceHash: capsule.baselineGitEvidenceHash,
        finalGitEvidenceHash: capsule.finalGitEvidenceHash,
        verificationResultsHash: capsule.verificationResultsHash,
        executionArtifactSetHash: capsule.executionArtifactSetHash,
        artifacts: capsule.executionArtifactManifest
      }
    }
  ];

  const parts = [
    title.part, objective.part, context.part,
    ...constraints.map(item => item.part), ...acceptanceCriteria.map(item => item.part),
    summary.part, model.part, finalDiff.part, baselineDiff.part,
    ...verificationEntries.flatMap(item => [item.operationSummary.part, item.stdout.part, item.stderr.part]),
    transcript.part, policyPrompt.part
  ];

  const manifest: ReviewMaterialManifest = parts.map(part => ({
    itemId: part.sectionId,
    itemType: manifestItemTypeFor(part.category),
    logicalPath: part.sectionId,
    contentHash: part.fullRawContentHash,
    originalByteCount: part.originalByteCount,
    includedByteCount: part.includedByteCount,
    omittedByteCount: part.omittedByteCount,
    truncated: part.reviewerTruncated || part.producerTruncated,
    truncationMethod: part.truncationMethod,
    redactionApplied: part.redactionApplied,
    encoding: "utf8" as const
  }));

  const byId = (sectionId: string): unknown => sections.find(section => section.sectionId === sectionId)!.value;

  // --- step 1: the core, complete and immutable ---------------------------
  const core: ReviewMaterialCore = reviewMaterialCoreSchema.parse({
    schemaVersion: REVIEW_MATERIAL_CORE_VERSION,
    reviewedRequestHash,
    approvedSpecification: {
      ...(byId("approvedSpecification") as Record<string, unknown>),
      constraints: byId("approvedSpecification.constraints"),
      acceptanceCriteria: byId("approvedSpecification.acceptanceCriteria")
    },
    gitEvidence: byId("gitEvidence") as Record<string, unknown>,
    patchEvidence: byId("patchEvidence") as Record<string, unknown>,
    changedFileEvidence: byId("changedFileEvidence") as Record<string, unknown>,
    verificationEvidence: {
      ...(byId("verificationEvidence") as Record<string, unknown>),
      stderr: byId("verificationEvidence.stderr")
    },
    executionLogEvidence: byId("executionLogEvidence") as Record<string, unknown>,
    executionSummary: { ...(byId("identity") as Record<string, unknown>), ...(byId("executionSummary") as Record<string, unknown>), evidenceIdentity: byId("evidenceIdentity") },
    evidenceManifest: manifest,
    provenanceDisclosure
  } satisfies ReviewMaterialCore);

  // --- step 2: the ledger, measured from that exact core -------------------
  // Rows compose the core exactly once, so nothing is double-counted and
  // nothing escapes counting. `serializedBytes` is measured by running the
  // REAL serializer over the REAL rendered value.
  const ledgerInputs: MaterialLedgerSectionInput[] = sections.map(section => {
    const serializedFragment = serializeMaterialFragment(section.value);
    // A section with no text fragments is pure structural metadata: its
    // content IS its serialization. A section with text fragments is charged
    // the real content bytes of those fragments against its category cap,
    // while its full serialized size (framing, escaping, metadata included)
    // is what counts toward the aggregate.
    const includedContentBytes = section.texts.length
      ? section.texts.reduce((sum, text) => sum + text.part.includedByteCount, 0)
      : utf8ByteLength(serializedFragment);
    const originalBytes = section.texts.length
      ? section.texts.reduce((sum, text) => sum + text.part.originalByteCount, 0)
      : utf8ByteLength(serializedFragment);
    return {
      category: section.category,
      sectionId: section.sectionId,
      originalBytes,
      includedContentBytes,
      serializedFragment,
      redactionOmittedBytes: section.texts.reduce((sum, text) => sum + text.part.redactedByteCount, 0),
      truncationOmittedBytes: section.texts.reduce((sum, text) => sum + Math.max(0, text.part.omittedByteCount - text.part.redactedByteCount), 0),
      artifactCount: new Set([...section.texts.map(text => text.part.sourceArtifactId), ...(section.artifactIds ?? [])].filter(Boolean)).size,
      contentHash: sha256OfText(serializedFragment)
    };
  });
  // The manifest and the provenance disclosure are transmitted content too --
  // they are inside the core, and their bytes are charged like any other
  // section rather than riding along uncounted.
  const manifestFragment = serializeMaterialFragment(manifest);
  ledgerInputs.push({
    category: "ARTIFACT_MANIFEST", sectionId: "evidenceManifest",
    originalBytes: utf8ByteLength(manifestFragment), includedContentBytes: utf8ByteLength(manifestFragment),
    serializedFragment: manifestFragment, contentHash: sha256OfText(manifestFragment)
  });
  const provenanceFragment = serializeMaterialFragment(provenanceDisclosure);
  ledgerInputs.push({
    category: "ARTIFACT_MANIFEST", sectionId: "provenanceDisclosure",
    originalBytes: utf8ByteLength(provenanceFragment), includedContentBytes: utf8ByteLength(provenanceFragment),
    serializedFragment: provenanceFragment, contentHash: sha256OfText(provenanceFragment)
  });
  // The core's own version/identity framing, charged rather than assumed free.
  const framingFragment = serializeMaterialFragment({ schemaVersion: core.schemaVersion, reviewedRequestHash: core.reviewedRequestHash });
  ledgerInputs.push({
    category: "EXECUTION_SUMMARY", sectionId: "coreFraming",
    originalBytes: utf8ByteLength(framingFragment), includedContentBytes: utf8ByteLength(framingFragment),
    serializedFragment: framingFragment, contentHash: sha256OfText(framingFragment)
  });
  ledgerInputs.push({
    category: "REVIEWER_POLICY_PROMPT",
    sectionId: policyPrompt.part.sectionId,
    originalBytes: policyPrompt.part.originalByteCount,
    includedContentBytes: policyPrompt.part.includedByteCount,
    // The policy header is emitted as raw prompt text, not as JSON, so its
    // serialized cost is its own exact UTF-8 bytes -- never zero.
    serializedFragment: policyPrompt.text,
    contentHash: policyPrompt.part.fullRawContentHash
  });

  const categoryLedger = buildMaterialByteLedger(ledgerInputs);
  const coreJson = canonicalJson(core);
  const coreCanonicalByteCount = utf8ByteLength(coreJson);
  const sectionSerializedTotal = categoryLedger.sections
    .filter(section => section.sectionId !== policyPrompt.part.sectionId)
    .reduce((sum, section) => sum + section.serializedBytes, 0);

  const ledger: ReviewMaterialLedger = reviewMaterialLedgerSchema.parse({
    schemaVersion: REVIEW_MATERIAL_LEDGER_VERSION,
    policyVersion: MATERIAL_BUDGET_POLICY_VERSION,
    budgetVersion: AUTHORITATIVE_REVIEW_MATERIAL_BUDGET.budgetVersion,
    sectionEntries: categoryLedger.sections,
    coreCanonicalByteCount,
    manifestByteCount: utf8ByteLength(canonicalJson(core.evidenceManifest)),
    provenanceByteCount: utf8ByteLength(canonicalJson(core.provenanceDisclosure)),
    outerFramingByteCount: Math.max(0, coreCanonicalByteCount - sectionSerializedTotal),
    originalSourceByteCount: categoryLedger.totals.originalBytes,
    includedContentByteCount: categoryLedger.totals.includedContentBytes,
    redactionOmittedByteCount: categoryLedger.totals.redactionOmittedBytes,
    truncationOmittedByteCount: categoryLedger.totals.truncationOmittedBytes,
    artifactCount: categoryLedger.totals.artifactCount
  } satisfies ReviewMaterialLedger);

  // --- step 3: the envelope, assembled from immutable parts and serialized ONCE ---
  const envelope: ReviewMaterialEnvelope = reviewMaterialEnvelopeSchema.parse({
    schemaVersion: REVIEW_MATERIAL_ENVELOPE_VERSION, core, ledger
  } satisfies ReviewMaterialEnvelope);
  const serialized = serializeReviewMaterialEnvelope(envelope);

  return {
    envelope,
    envelopeJson: serialized.json,
    envelopeByteCount: serialized.byteCount,
    materialHash: serialized.hash,
    core,
    ledger,
    ledgerHash: sha256OfText(canonicalJson(ledger)),
    categoryLedger,
    manifest,
    parts
  };
}

function manifestItemTypeFor(category: AuthoritativeReviewMaterialCategory): ReviewMaterialManifest[number]["itemType"] {
  switch (category) {
    case "APPROVED_SPEC": case "CONSTRAINTS": case "ACCEPTANCE_CRITERIA": return "TASK_SPEC";
    case "GIT_DIFF": case "CHANGED_FILE_METADATA": return "FINAL_GIT_EVIDENCE";
    case "VERIFICATION_STDOUT": case "VERIFICATION_STDERR": return "VERIFICATION_RESULT";
    case "EXECUTION_LOG": return "EXECUTION_LOG";
    case "ARTIFACT_MANIFEST": return "EXECUTION_ARTIFACT";
    default: return "EXECUTION_SUMMARY";
  }
}
