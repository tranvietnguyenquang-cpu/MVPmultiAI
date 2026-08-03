CREATE TABLE "ReviewRequest" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "executionSessionId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "taskId" TEXT NOT NULL,
  "reviewerId" TEXT NOT NULL CHECK ("reviewerId" = 'fake-reviewer'),
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

CREATE TABLE "ReviewVerdict" (
  "id" TEXT NOT NULL PRIMARY KEY,
  -- UNIQUE (not just an index): the database itself enforces at most one
  -- ReviewVerdict per ReviewRequest, independent of the application-level CAS.
  "reviewRequestId" TEXT NOT NULL UNIQUE,
  "verdict" TEXT NOT NULL CHECK ("verdict" IN ('APPROVE','REJECT','NEEDS_CHANGES')),
  "summary" TEXT NOT NULL,
  "findingsJson" TEXT NOT NULL CHECK (json_valid("findingsJson")),
  "requiredActionsJson" TEXT NOT NULL CHECK (json_valid("requiredActionsJson")),
  "confidence" REAL NOT NULL CHECK ("confidence" >= 0 AND "confidence" <= 1),
  "reviewerVersion" TEXT NOT NULL,
  "reviewedRequestHash" TEXT NOT NULL CHECK (length("reviewedRequestHash") = 64),
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReviewVerdict_reviewRequestId_fkey" FOREIGN KEY ("reviewRequestId") REFERENCES "ReviewRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "ReviewEvent" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "reviewRequestId" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL CHECK ("sequence" >= 1),
  "eventType" TEXT NOT NULL CHECK ("eventType" IN (
    'REVIEW_REQUESTED','REVIEW_ELIGIBILITY_REJECTED','REVIEW_CLAIMED','REVIEW_STARTED','REVIEWER_OUTPUT_RECEIVED',
    'REVIEW_APPROVED','REVIEW_REJECTED','REVIEW_NEEDS_CHANGES','REVIEW_ERROR',
    'REVIEW_CANCELLATION_REQUESTED','REVIEW_CANCELLED','REVIEW_STALE_INVALIDATED','REVIEW_EVIDENCE_RECHECKED',
    'REVIEW_STALE_LEASE_RECOVERED'
  )),
  "level" TEXT NOT NULL CHECK ("level" IN ('DEBUG','INFO','WARNING','ERROR')),
  "message" TEXT NOT NULL,
  "payloadJson" TEXT NOT NULL CHECK (json_valid("payloadJson")),
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReviewEvent_reviewRequestId_fkey" FOREIGN KEY ("reviewRequestId") REFERENCES "ReviewRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "ReviewRequest_executionSessionId_createdAt_idx" ON "ReviewRequest"("executionSessionId", "createdAt");
CREATE INDEX "ReviewRequest_projectId_createdAt_idx" ON "ReviewRequest"("projectId", "createdAt");
CREATE INDEX "ReviewRequest_taskId_createdAt_idx" ON "ReviewRequest"("taskId", "createdAt");
CREATE INDEX "ReviewRequest_status_requestedAt_idx" ON "ReviewRequest"("status", "requestedAt");
CREATE INDEX "ReviewRequest_status_leaseExpiresAt_idx" ON "ReviewRequest"("status", "leaseExpiresAt");

-- Only one active (non-terminal) review may exist per execution session at a time.
CREATE UNIQUE INDEX "ReviewRequest_one_active_execution" ON "ReviewRequest"("executionSessionId") WHERE "status" IN ('PENDING','CLAIMED','RUNNING','CANCELLATION_REQUESTED');

CREATE UNIQUE INDEX "ReviewEvent_reviewRequestId_sequence_key" ON "ReviewEvent"("reviewRequestId", "sequence");
CREATE INDEX "ReviewEvent_reviewRequestId_createdAt_idx" ON "ReviewEvent"("reviewRequestId", "createdAt");

CREATE TRIGGER "ReviewVerdict_no_update" BEFORE UPDATE ON "ReviewVerdict"
BEGIN SELECT RAISE(ABORT, 'ReviewVerdict is append-only'); END;

CREATE TRIGGER "ReviewVerdict_no_delete" BEFORE DELETE ON "ReviewVerdict"
BEGIN SELECT RAISE(ABORT, 'ReviewVerdict is append-only'); END;

CREATE TRIGGER "ReviewEvent_no_update" BEFORE UPDATE ON "ReviewEvent"
BEGIN SELECT RAISE(ABORT, 'ReviewEvent is append-only'); END;

CREATE TRIGGER "ReviewEvent_no_delete" BEFORE DELETE ON "ReviewEvent"
BEGIN SELECT RAISE(ABORT, 'ReviewEvent is append-only'); END;

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
  NEW."requestHash" IS NOT OLD."requestHash" OR
  NEW."requestedBy" IS NOT OLD."requestedBy" OR
  NEW."requestedAt" IS NOT OLD."requestedAt"
BEGIN SELECT RAISE(ABORT, 'ReviewRequest immutable payload fields cannot change'); END;

CREATE TRIGGER "ReviewRequest_no_delete" BEFORE DELETE ON "ReviewRequest"
BEGIN SELECT RAISE(ABORT, 'ReviewRequest cannot be deleted'); END;
