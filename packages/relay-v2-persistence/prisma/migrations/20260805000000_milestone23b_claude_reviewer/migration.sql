-- Atomicity follows sqlite.org's documented 12-step procedure for altering a
-- table in ways ALTER TABLE cannot express directly ("Making Other Kinds Of
-- Table Schema Changes", https://www.sqlite.org/lang_altertable.html):
-- disable foreign-key enforcement *outside* any transaction (it is a no-op
-- inside one), then perform the entire rebuild -- table copy, drop, rename,
-- every index/trigger recreation, and every new table -- inside one explicit
-- transaction so a failure at any point rolls back completely and leaves no
-- partial schema, then verify referential integrity, then commit, then only
-- afterward re-enable foreign-key enforcement (also required to run outside
-- a transaction). Milestone 2.3B's original migration was missing the
-- explicit BEGIN/COMMIT pair, relying on whatever transaction-wrapping
-- behavior the migration runner happened to apply by default.
PRAGMA foreign_keys=OFF;

BEGIN TRANSACTION;

-- Truthful producer-truncation provenance for every execution artifact.
-- `sha256`/`byteCount` describe the bytes actually on disk; these columns
-- describe what existed BEFORE any truncation, so a consumer can always tell
-- that what it holds is not the whole thing. Plain ADD COLUMNs on a table
-- created by an earlier, already-committed migration -- that migration is not
-- touched. Backfill values are deliberately the "unknown provenance" defaults
-- ('' / 0 / 'NONE'): a pre-existing row genuinely has no recorded original
-- size, and an AUTHORITATIVE review refuses such an artifact rather than
-- treating an invented zero as proof of completeness.
ALTER TABLE "ExecutionArtifact" ADD COLUMN "schemaVersion" TEXT NOT NULL DEFAULT '';
ALTER TABLE "ExecutionArtifact" ADD COLUMN "fullContentSha256" TEXT NOT NULL DEFAULT '';
ALTER TABLE "ExecutionArtifact" ADD COLUMN "originalByteCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ExecutionArtifact" ADD COLUMN "omittedByteCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ExecutionArtifact" ADD COLUMN "truncationMethod" TEXT NOT NULL DEFAULT 'NONE';
-- The producer's own versioned provenance object, stored verbatim so a
-- reviewer carries it through unchanged rather than re-deriving a weaker
-- version of it from the scalar columns above (LOG record counts and capture
-- completeness have no scalar column, and inventing them is exactly what this
-- avoids). '{}' for a pre-existing row and for artifact types that add nothing.
ALTER TABLE "ExecutionArtifact" ADD COLUMN "provenanceJson" TEXT NOT NULL DEFAULT '{}';

-- Rebuild ReviewRequest only to widen the reviewerId CHECK from the
-- Milestone 2.3A hard pin ('fake-reviewer' only) to also allow the real
-- Milestone 2.3B Claude CLI reviewer ('claude-cli'). No column is added,
-- removed, or renamed, so a plain `SELECT *` copy preserves every existing
-- row exactly. Every index and trigger previously defined on this table is
-- dropped implicitly by DROP TABLE and is recreated below, unchanged.
CREATE TABLE "ReviewRequest_m23b" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "executionSessionId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "taskId" TEXT NOT NULL,
  "reviewerId" TEXT NOT NULL CHECK ("reviewerId" IN ('fake-reviewer','claude-cli')),
  "reviewAuthority" TEXT NOT NULL CHECK ("reviewAuthority" IN ('AUTHORITATIVE','DIAGNOSTIC')),
  "diagnosticRequested" BOOLEAN NOT NULL DEFAULT false,
  "approvalId" TEXT NOT NULL,
  "approvalStatus" TEXT NOT NULL,
  "approvalReviewerSelection" TEXT NOT NULL CHECK ("approvalReviewerSelection" IN ('NONE','AUTO','CODEX','CLAUDE')),
  "taskSelectedReviewer" TEXT NOT NULL CHECK ("taskSelectedReviewer" IN ('NONE','AUTO','CODEX','CLAUDE')),
  "executionExecutorId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING' CHECK ("status" IN ('PENDING','CLAIMED','RUNNING','CANCELLATION_REQUESTED','APPROVED','REJECTED','NEEDS_CHANGES','ERROR','CANCELLED','STALE')),
  "attempt" INTEGER NOT NULL DEFAULT 0 CHECK ("attempt" >= 0),
  "taskSpecHash" TEXT NOT NULL CHECK (length("taskSpecHash") = 64),
  "approvalSnapshotHash" TEXT NOT NULL CHECK (length("approvalSnapshotHash") = 64),
  "executionCapsuleHash" TEXT NOT NULL CHECK (length("executionCapsuleHash") = 64),
  "baselineGitEvidenceHash" TEXT NOT NULL CHECK (length("baselineGitEvidenceHash") = 64),
  "finalGitEvidenceHash" TEXT NOT NULL CHECK (length("finalGitEvidenceHash") = 64),
  "verificationResultsHash" TEXT NOT NULL CHECK (length("verificationResultsHash") = 64),
  "executionArtifactSetHash" TEXT NOT NULL CHECK (length("executionArtifactSetHash") = 64),
  "executionResultStatus" TEXT NOT NULL CHECK ("executionResultStatus" IN ('succeeded','failed','timed_out','cancelled','blocked')),
  "finalBranch" TEXT NOT NULL,
  "finalHead" TEXT NOT NULL,
  "reviewPolicyVersion" TEXT NOT NULL,
  "reviewInputJson" TEXT NOT NULL CHECK (json_valid("reviewInputJson")),
  "reviewInputHash" TEXT NOT NULL CHECK (length("reviewInputHash") = 64),
  "requestHash" TEXT NOT NULL CHECK (length("requestHash") = 64),
  "reviewerConfigJson" TEXT NOT NULL DEFAULT '{}' CHECK (json_valid("reviewerConfigJson")),
  "reviewerConfigHash" TEXT NOT NULL CHECK (length("reviewerConfigHash") = 64),
  -- The exact serialized material byte ledger this request's evidence was
  -- measured against, its canonical hash, and the ledger policy version. Bound
  -- into the request (and re-proved at finalization) so the budget a review was
  -- authorized under can never be reinterpreted after the fact.
  "materialBudgetPolicyVersion" TEXT NOT NULL DEFAULT '',
  "materialBudgetLedgerJson" TEXT NOT NULL DEFAULT '{}' CHECK (json_valid("materialBudgetLedgerJson")),
  "materialBudgetLedgerHash" TEXT NOT NULL DEFAULT '' CHECK (length("materialBudgetLedgerHash") = 0 OR length("materialBudgetLedgerHash") = 64),
  "requestedBy" TEXT NOT NULL,
  "requestedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ownerId" TEXT,
  "leaseToken" TEXT,
  "claimedAt" DATETIME,
  "heartbeatAt" DATETIME,
  "leaseExpiresAt" DATETIME,
  "cancellationRequestedAt" DATETIME,
  "claimAttempts" INTEGER NOT NULL DEFAULT 0 CHECK ("claimAttempts" >= 0),
  "startedAt" DATETIME,
  "finishedAt" DATETIME,
  "invalidatedAt" DATETIME,
  "failureCode" TEXT,
  "failureMessage" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "ReviewRequest_executionSessionId_fkey" FOREIGN KEY ("executionSessionId") REFERENCES "ExecutionSession"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ReviewRequest_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ReviewRequest_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Columns are listed explicitly rather than copied with `SELECT *`: the new
-- table adds three ledger-binding columns the old one does not have, so a
-- positional copy would silently misalign every column after them.
INSERT INTO "ReviewRequest_m23b" (
  "id","executionSessionId","projectId","taskId","reviewerId","reviewAuthority","diagnosticRequested",
  "approvalId","approvalStatus","approvalReviewerSelection","taskSelectedReviewer","executionExecutorId",
  "status","attempt","taskSpecHash","approvalSnapshotHash","executionCapsuleHash","baselineGitEvidenceHash",
  "finalGitEvidenceHash","verificationResultsHash","executionArtifactSetHash","executionResultStatus",
  "finalBranch","finalHead","reviewPolicyVersion","reviewInputJson","reviewInputHash","requestHash",
  "reviewerConfigJson","reviewerConfigHash","requestedBy","requestedAt","ownerId","leaseToken","claimedAt",
  "heartbeatAt","leaseExpiresAt","cancellationRequestedAt","claimAttempts","startedAt","finishedAt",
  "invalidatedAt","failureCode","failureMessage","createdAt","updatedAt"
)
SELECT
  "id","executionSessionId","projectId","taskId","reviewerId","reviewAuthority","diagnosticRequested",
  "approvalId","approvalStatus","approvalReviewerSelection","taskSelectedReviewer","executionExecutorId",
  "status","attempt","taskSpecHash","approvalSnapshotHash","executionCapsuleHash","baselineGitEvidenceHash",
  "finalGitEvidenceHash","verificationResultsHash","executionArtifactSetHash","executionResultStatus",
  "finalBranch","finalHead","reviewPolicyVersion","reviewInputJson","reviewInputHash","requestHash",
  "reviewerConfigJson","reviewerConfigHash","requestedBy","requestedAt","ownerId","leaseToken","claimedAt",
  "heartbeatAt","leaseExpiresAt","cancellationRequestedAt","claimAttempts","startedAt","finishedAt",
  "invalidatedAt","failureCode","failureMessage","createdAt","updatedAt"
FROM "ReviewRequest";
DROP TABLE "ReviewRequest";
ALTER TABLE "ReviewRequest_m23b" RENAME TO "ReviewRequest";

CREATE INDEX "ReviewRequest_executionSessionId_createdAt_idx" ON "ReviewRequest"("executionSessionId", "createdAt");
CREATE INDEX "ReviewRequest_projectId_createdAt_idx" ON "ReviewRequest"("projectId", "createdAt");
CREATE INDEX "ReviewRequest_taskId_createdAt_idx" ON "ReviewRequest"("taskId", "createdAt");
CREATE INDEX "ReviewRequest_status_requestedAt_idx" ON "ReviewRequest"("status", "requestedAt");
CREATE INDEX "ReviewRequest_status_leaseExpiresAt_idx" ON "ReviewRequest"("status", "leaseExpiresAt");

-- Only one active (non-terminal) review may exist per execution session at a time.
CREATE UNIQUE INDEX "ReviewRequest_one_active_execution" ON "ReviewRequest"("executionSessionId") WHERE "status" IN ('PENDING','CLAIMED','RUNNING','CANCELLATION_REQUESTED');

-- A ReviewRequest may never be mutated once it reaches a terminal status.
CREATE TRIGGER "ReviewRequest_terminal_immutable" BEFORE UPDATE ON "ReviewRequest"
WHEN OLD."status" IN ('APPROVED','REJECTED','NEEDS_CHANGES','ERROR','CANCELLED','STALE')
BEGIN SELECT RAISE(ABORT, 'ReviewRequest is immutable once terminal'); END;

-- The authority/evidence/binding payload never changes in ANY state (not only
-- once terminal): only the controlled lifecycle/lease columns below may be
-- updated. Application code enforces this too, but the database is the
-- backstop against a direct or buggy write bypassing ReviewEngine.
CREATE TRIGGER "ReviewRequest_immutable_payload" BEFORE UPDATE ON "ReviewRequest"
WHEN
  NEW."executionSessionId" IS NOT OLD."executionSessionId" OR
  NEW."projectId" IS NOT OLD."projectId" OR
  NEW."taskId" IS NOT OLD."taskId" OR
  NEW."reviewerId" IS NOT OLD."reviewerId" OR
  NEW."reviewAuthority" IS NOT OLD."reviewAuthority" OR
  NEW."diagnosticRequested" IS NOT OLD."diagnosticRequested" OR
  NEW."approvalId" IS NOT OLD."approvalId" OR
  NEW."approvalStatus" IS NOT OLD."approvalStatus" OR
  NEW."approvalReviewerSelection" IS NOT OLD."approvalReviewerSelection" OR
  NEW."taskSelectedReviewer" IS NOT OLD."taskSelectedReviewer" OR
  NEW."executionExecutorId" IS NOT OLD."executionExecutorId" OR
  NEW."attempt" IS NOT OLD."attempt" OR
  NEW."taskSpecHash" IS NOT OLD."taskSpecHash" OR
  NEW."approvalSnapshotHash" IS NOT OLD."approvalSnapshotHash" OR
  NEW."executionCapsuleHash" IS NOT OLD."executionCapsuleHash" OR
  NEW."baselineGitEvidenceHash" IS NOT OLD."baselineGitEvidenceHash" OR
  NEW."finalGitEvidenceHash" IS NOT OLD."finalGitEvidenceHash" OR
  NEW."verificationResultsHash" IS NOT OLD."verificationResultsHash" OR
  NEW."executionArtifactSetHash" IS NOT OLD."executionArtifactSetHash" OR
  NEW."executionResultStatus" IS NOT OLD."executionResultStatus" OR
  NEW."finalBranch" IS NOT OLD."finalBranch" OR
  NEW."finalHead" IS NOT OLD."finalHead" OR
  NEW."reviewPolicyVersion" IS NOT OLD."reviewPolicyVersion" OR
  NEW."reviewInputJson" IS NOT OLD."reviewInputJson" OR
  NEW."reviewInputHash" IS NOT OLD."reviewInputHash" OR
  NEW."reviewerConfigJson" IS NOT OLD."reviewerConfigJson" OR
  NEW."reviewerConfigHash" IS NOT OLD."reviewerConfigHash" OR
  NEW."materialBudgetPolicyVersion" IS NOT OLD."materialBudgetPolicyVersion" OR
  NEW."materialBudgetLedgerJson" IS NOT OLD."materialBudgetLedgerJson" OR
  NEW."materialBudgetLedgerHash" IS NOT OLD."materialBudgetLedgerHash" OR
  NEW."requestHash" IS NOT OLD."requestHash" OR
  NEW."requestedBy" IS NOT OLD."requestedBy" OR
  NEW."requestedAt" IS NOT OLD."requestedAt"
BEGIN SELECT RAISE(ABORT, 'ReviewRequest immutable payload fields cannot change'); END;

CREATE TRIGGER "ReviewRequest_no_delete" BEFORE DELETE ON "ReviewRequest"
BEGIN SELECT RAISE(ABORT, 'ReviewRequest cannot be deleted'); END;

-- Reviewer-agnostic capability diagnostic history (mirrors ExecutorCapabilitySnapshot
-- from Milestone 2.2). Append-only: every refresh inserts a new row.
CREATE TABLE "ReviewerCapabilitySnapshot" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "reviewerId" TEXT NOT NULL CHECK ("reviewerId" IN ('claude-cli')),
  "displayPath" TEXT NOT NULL,
  "version" TEXT NOT NULL,
  "authenticationStatus" TEXT NOT NULL CHECK ("authenticationStatus" IN ('AUTHENTICATED','UNAUTHENTICATED','UNKNOWN','UNAVAILABLE')),
  "supported" BOOLEAN NOT NULL,
  "snapshotJson" TEXT NOT NULL CHECK (json_valid("snapshotJson")),
  "helpHash" TEXT NOT NULL CHECK (length("helpHash") = 64),
  "detectedAt" DATETIME NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "ReviewerCapabilitySnapshot_reviewerId_detectedAt_idx" ON "ReviewerCapabilitySnapshot"("reviewerId", "detectedAt");

-- Exactly zero or one row per reviewRequestId (UNIQUE below): the one
-- durable, ownership-guarded lifecycle record of that request's single
-- reviewer invocation attempt (PREPARING at claim time through a terminal
-- status), enriched in place with process/hash detail by the reviewer
-- through ReviewControls.recordInvocation. ReviewEngine is the only writer,
-- and only ever the exact ownership generation (ownerId/claimAttempt) that
-- created the row -- created atomically via
-- ReviewEngine.createOwnedInvocationOrThrow only after the owning
-- ReviewRequest is proven RUNNING under that generation, and never before a
-- prior create/update using a stale generation is possible (see the
-- immutable-identity trigger below). A ReviewRequest can be claimed at most
-- once ever (claimNext requires PENDING and there is no path back to
-- PENDING), so this table can never legitimately hold a second row for the
-- same request -- there is no automatic retry to make room for one. Has no
-- bearing on review verdict acceptance, but IS the basis for quarantining a
-- new authoritative request while a prior invocation's outcome is unproven
-- (see ReviewEngine.requestReview/recoverStaleReviews).
CREATE TABLE "ReviewInvocation" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "reviewRequestId" TEXT NOT NULL,
  "reviewerId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PREPARING' CHECK ("status" IN ('PREPARING','RUNNING','SUCCEEDED','FAILED','TIMED_OUT','CANCELLED','OWNERSHIP_LOST','INTERRUPTED_UNCERTAIN')),
  "ownerId" TEXT NOT NULL,
  "claimAttempt" INTEGER NOT NULL DEFAULT 0 CHECK ("claimAttempt" >= 0),
  "capabilitySnapshotId" TEXT,
  "cliVersion" TEXT NOT NULL DEFAULT '',
  "executableIdentityHash" TEXT NOT NULL DEFAULT '',
  "materializerVersion" TEXT NOT NULL DEFAULT '',
  "promptPolicyVersion" TEXT NOT NULL DEFAULT '',
  "wrapperContractId" TEXT NOT NULL DEFAULT '',
  "wrapperParserVersion" TEXT NOT NULL DEFAULT '',
  -- The complete transmitted identity of the one invocation this request is
  -- allowed to have: the exact material envelope, its exact ledger, the exact
  -- prompt, and the exact stdin, with the measured byte count of every string
  -- actually built. All of it is written when the row is INSERTED, before the
  -- reviewer process exists -- not patched in after that process exits, which
  -- is what previously left a window where the row described nothing at all.
  -- Finalization independently rebuilds every one of these values from current
  -- evidence and requires an exact match before a verdict may be inserted.
  "materialEnvelopeVersion" TEXT NOT NULL DEFAULT '',
  "materialBudgetPolicyVersion" TEXT NOT NULL DEFAULT '',
  "materialBudgetLedgerJson" TEXT NOT NULL DEFAULT '{}' CHECK (json_valid("materialBudgetLedgerJson")),
  "reviewMaterialHash" TEXT NOT NULL DEFAULT '' CHECK (length("reviewMaterialHash") = 0 OR length("reviewMaterialHash") = 64),
  "exactMaterialEnvelopeByteCount" INTEGER NOT NULL DEFAULT 0 CHECK ("exactMaterialEnvelopeByteCount" >= 0),
  "promptHash" TEXT NOT NULL DEFAULT '' CHECK (length("promptHash") = 0 OR length("promptHash") = 64),
  "finalPromptByteCount" INTEGER NOT NULL DEFAULT 0 CHECK ("finalPromptByteCount" >= 0),
  "materialBudgetLedgerHash" TEXT NOT NULL DEFAULT '' CHECK (length("materialBudgetLedgerHash") = 0 OR length("materialBudgetLedgerHash") = 64),
  "finalStdinHash" TEXT NOT NULL DEFAULT '' CHECK (length("finalStdinHash") = 0 OR length("finalStdinHash") = 64),
  "finalStdinByteCount" INTEGER NOT NULL DEFAULT 0 CHECK ("finalStdinByteCount" >= 0),
  "promptAccountingJson" TEXT NOT NULL DEFAULT '{}' CHECK (json_valid("promptAccountingJson")),
  "stdoutRedacted" TEXT NOT NULL DEFAULT '',
  "stdoutTruncated" BOOLEAN NOT NULL DEFAULT false,
  "stderrRedacted" TEXT NOT NULL DEFAULT '',
  "stderrTruncated" BOOLEAN NOT NULL DEFAULT false,
  "structuredOutputJson" TEXT,
  "processId" INTEGER CHECK ("processId" IS NULL OR "processId" > 0),
  "processIdentity" TEXT,
  "processStartedAt" DATETIME,
  "processFinishedAt" DATETIME,
  "processExitCode" INTEGER,
  "processSignal" TEXT,
  "timedOut" BOOLEAN NOT NULL DEFAULT false,
  "cancelled" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "ReviewInvocation_reviewRequestId_fkey" FOREIGN KEY ("reviewRequestId") REFERENCES "ReviewRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ReviewInvocation_capabilitySnapshotId_fkey" FOREIGN KEY ("capabilitySnapshotId") REFERENCES "ReviewerCapabilitySnapshot"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
-- The database-level backstop for "exactly zero or one invocation per
-- review request": even a buggy or racing caller that bypasses
-- createOwnedInvocationOrThrow's own application-level check cannot insert a
-- second row for the same reviewRequestId.
CREATE UNIQUE INDEX "ReviewInvocation_reviewRequestId_key" ON "ReviewInvocation"("reviewRequestId");
CREATE INDEX "ReviewInvocation_reviewerId_createdAt_idx" ON "ReviewInvocation"("reviewerId", "createdAt");

CREATE TRIGGER "ReviewInvocation_no_delete" BEFORE DELETE ON "ReviewInvocation"
BEGIN SELECT RAISE(ABORT, 'ReviewInvocation cannot be deleted'); END;

-- Once terminal, immutable (mirrors ReviewRequest_terminal_immutable) --
-- a stale owner that lost its lease cannot later overwrite a row a
-- recovery path (or the true owner) already finalized.
CREATE TRIGGER "ReviewInvocation_terminal_immutable" BEFORE UPDATE ON "ReviewInvocation"
WHEN OLD."status" IN ('SUCCEEDED','FAILED','TIMED_OUT','CANCELLED','OWNERSHIP_LOST','INTERRUPTED_UNCERTAIN')
BEGIN SELECT RAISE(ABORT, 'ReviewInvocation is immutable once terminal'); END;

-- The identity/ownership-generation fields can never change on an UPDATE --
-- only the reviewer/process detail fields plus status may be written, and
-- application code additionally requires (via a CAS predicate) that any
-- UPDATE's WHERE clause still match the row's current ownerId/claimAttempt;
-- this trigger is the database backstop against a direct or buggy write
-- changing which ownership generation a row belongs to.
CREATE TRIGGER "ReviewInvocation_immutable_identity" BEFORE UPDATE ON "ReviewInvocation"
WHEN
  NEW."reviewRequestId" IS NOT OLD."reviewRequestId" OR
  NEW."reviewerId" IS NOT OLD."reviewerId" OR
  NEW."ownerId" IS NOT OLD."ownerId" OR
  NEW."claimAttempt" IS NOT OLD."claimAttempt" OR
  NEW."createdAt" IS NOT OLD."createdAt"
BEGIN SELECT RAISE(ABORT, 'ReviewInvocation identity/ownership fields cannot change'); END;

-- The transmitted-material identity is write-once. It is bound at INSERT,
-- before the reviewer process exists, and an UPDATE may never rewrite a bound
-- value -- so the reviewer's own post-hoc detail report cannot restate (or
-- quietly correct) what was actually sent, and a verdict can only ever be
-- accepted against the identity that was committed before the process started.
-- The `OLD.<field> <> <empty>` guard leaves a reviewer that binds no material
-- (FakeReviewer never prepares one) free to record its detail report normally.
CREATE TRIGGER "ReviewInvocation_immutable_material_identity" BEFORE UPDATE ON "ReviewInvocation"
WHEN
  (OLD."materialEnvelopeVersion" <> '' AND NEW."materialEnvelopeVersion" IS NOT OLD."materialEnvelopeVersion") OR
  (OLD."materialBudgetPolicyVersion" <> '' AND NEW."materialBudgetPolicyVersion" IS NOT OLD."materialBudgetPolicyVersion") OR
  (OLD."materialBudgetLedgerJson" <> '{}' AND NEW."materialBudgetLedgerJson" IS NOT OLD."materialBudgetLedgerJson") OR
  (OLD."materialBudgetLedgerHash" <> '' AND NEW."materialBudgetLedgerHash" IS NOT OLD."materialBudgetLedgerHash") OR
  (OLD."reviewMaterialHash" <> '' AND NEW."reviewMaterialHash" IS NOT OLD."reviewMaterialHash") OR
  (OLD."exactMaterialEnvelopeByteCount" <> 0 AND NEW."exactMaterialEnvelopeByteCount" IS NOT OLD."exactMaterialEnvelopeByteCount") OR
  (OLD."promptHash" <> '' AND NEW."promptHash" IS NOT OLD."promptHash") OR
  (OLD."finalPromptByteCount" <> 0 AND NEW."finalPromptByteCount" IS NOT OLD."finalPromptByteCount") OR
  (OLD."finalStdinHash" <> '' AND NEW."finalStdinHash" IS NOT OLD."finalStdinHash") OR
  (OLD."finalStdinByteCount" <> 0 AND NEW."finalStdinByteCount" IS NOT OLD."finalStdinByteCount")
BEGIN SELECT RAISE(ABORT, 'ReviewInvocation transmitted-material identity is write-once'); END;

-- Verify referential integrity before committing (sqlite.org's own
-- recommended placement: after the rebuild, before COMMIT). A bare
-- `PRAGMA foreign_key_check;` only ever returns a result set describing any
-- violations -- it is a no-op with respect to script/transaction control and
-- can NEVER by itself abort a script or a COMMIT, so it must never be relied
-- on alone. Instead, route the violation count through a CHECK constraint,
-- which SQLite *does* enforce as a real constraint violation that aborts the
-- statement (and, since we are still inside the explicit BEGIN/COMMIT above,
-- the whole transaction): a temp table whose single column is constrained to
-- always equal zero, fed from `pragma_foreign_key_check()` (the table-valued
-- function form of the same pragma). Zero violations inserts cleanly and the
-- guard table is dropped immediately after; one or more violations raises a
-- CHECK constraint failure, which prevents COMMIT and rolls back the entire
-- rebuild -- verified through the real `prisma migrate deploy` path (not by
-- SQL string inspection alone) by migration-path.test.ts's
-- "actual foreign-key violation makes migration deploy fail and roll back"
-- case, which seeds a real dangling foreign key via a disabled-FK insert and
-- confirms the ORIGINAL table/data/indexes/triggers survive untouched and
-- foreign-key enforcement is restored afterward.
CREATE TEMP TABLE "_relay_fk_guard" (
  "violation_count" INTEGER NOT NULL CHECK ("violation_count" = 0)
);
INSERT INTO "_relay_fk_guard"("violation_count") SELECT COUNT(*) FROM pragma_foreign_key_check;
DROP TABLE "_relay_fk_guard";

COMMIT;

PRAGMA foreign_keys=ON;
