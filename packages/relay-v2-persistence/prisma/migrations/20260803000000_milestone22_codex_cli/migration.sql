PRAGMA foreign_keys=OFF;

-- Rebuild Task only to widen the approved executor CHECK with the diagnostic
-- FakeExecutor. Existing rows and all legacy relationships are copied as-is.
CREATE TABLE "Task_m22" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "projectId" TEXT NOT NULL,
  "externalId" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "objective" TEXT NOT NULL,
  "source" TEXT NOT NULL CHECK ("source" IN ('MANUAL','HANDOFF_JSON','HANDOFF_YAML','CLIPBOARD','FILE_IMPORT','LEGACY_PREVIEW','MCP','CHATGPT')),
  "taskType" TEXT NOT NULL CHECK ("taskType" IN ('IMPLEMENTATION','BUGFIX','DOCUMENTATION','ANALYSIS','MIGRATION','SECURITY','OPERATIONS','OTHER')),
  "complexity" TEXT NOT NULL CHECK ("complexity" IN ('TRIVIAL','NORMAL','COMPLEX','CRITICAL')),
  "status" TEXT NOT NULL DEFAULT 'DRAFT' CHECK ("status" IN ('DRAFT','PENDING_APPROVAL','APPROVED','QUEUED','RUNNING','AWAITING_REVIEW','REVIEW_FAILED','AWAITING_USER_ACCEPTANCE','COMPLETED','FAILED','CANCELLED','BLOCKED')),
  "context" TEXT NOT NULL DEFAULT '',
  "suggestedExecutor" TEXT NOT NULL DEFAULT 'AUTO',
  "suggestedModel" TEXT NOT NULL DEFAULT 'AUTO',
  "suggestedEffort" TEXT NOT NULL DEFAULT 'AUTO',
  "selectedExecutor" TEXT NOT NULL DEFAULT 'AUTO' CHECK ("selectedExecutor" IN ('AUTO','FAKE','CODEX','CLAUDE')),
  "selectedModel" TEXT NOT NULL DEFAULT 'AUTO',
  "selectedEffort" TEXT NOT NULL DEFAULT 'AUTO' CHECK ("selectedEffort" IN ('AUTO','LOW','MEDIUM','HIGH')),
  "reviewer" TEXT NOT NULL DEFAULT 'AUTO' CHECK ("reviewer" IN ('NONE','AUTO','CODEX','CLAUDE')),
  "requireApproval" BOOLEAN NOT NULL DEFAULT true CHECK ("requireApproval" = true),
  "specVersion" INTEGER NOT NULL DEFAULT 1 CHECK ("specVersion" >= 1),
  "specHash" TEXT NOT NULL,
  "normalizedSpecJson" TEXT NOT NULL CHECK (json_valid("normalizedSpecJson")),
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  "approvedAt" DATETIME,
  "cancelledAt" DATETIME,
  CONSTRAINT "Task_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "Task_m22" SELECT * FROM "Task";
DROP TABLE "Task";
ALTER TABLE "Task_m22" RENAME TO "Task";
CREATE UNIQUE INDEX "Task_projectId_source_idempotencyKey_key" ON "Task"("projectId", "source", "idempotencyKey");
CREATE UNIQUE INDEX "Task_projectId_source_externalId_key" ON "Task"("projectId", "source", "externalId");
CREATE INDEX "Task_projectId_status_createdAt_idx" ON "Task"("projectId", "status", "createdAt");

CREATE TABLE "Approval_m22" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "taskId" TEXT NOT NULL,
  "approvalType" TEXT NOT NULL,
  "requestedBy" TEXT NOT NULL,
  "resolvedBy" TEXT,
  "status" TEXT NOT NULL DEFAULT 'PENDING' CHECK ("status" IN ('PENDING','APPROVED','REJECTED','INVALIDATED')),
  "specHash" TEXT NOT NULL,
  "approvedSpecJson" TEXT NOT NULL CHECK (json_valid("approvedSpecJson")),
  "executor" TEXT NOT NULL CHECK ("executor" IN ('AUTO','FAKE','CODEX','CLAUDE')),
  "model" TEXT NOT NULL,
  "effort" TEXT NOT NULL CHECK ("effort" IN ('AUTO','LOW','MEDIUM','HIGH')),
  "reviewer" TEXT NOT NULL CHECK ("reviewer" IN ('NONE','AUTO','CODEX','CLAUDE')),
  "permissionsJson" TEXT NOT NULL CHECK (json_valid("permissionsJson")),
  "requestedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" DATETIME,
  "invalidatedAt" DATETIME,
  CONSTRAINT "Approval_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "Approval_m22" SELECT * FROM "Approval";
DROP TABLE "Approval";
ALTER TABLE "Approval_m22" RENAME TO "Approval";
CREATE INDEX "Approval_taskId_status_requestedAt_idx" ON "Approval"("taskId", "status", "requestedAt");

CREATE TABLE "ExecutionSession_m22" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "taskId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "executorId" TEXT NOT NULL CHECK ("executorId" IN ('fake','codex-cli')),
  "executorConfigJson" TEXT NOT NULL DEFAULT '{}' CHECK (json_valid("executorConfigJson")),
  "status" TEXT NOT NULL DEFAULT 'QUEUED' CHECK ("status" IN ('QUEUED','WAITING_FOR_WORKSPACE','CLAIMED','PREPARING','RUNNING','CANCELLATION_REQUESTED','SUCCEEDED','FAILED','TIMED_OUT','CANCELLED','BLOCKED')),
  "attempt" INTEGER NOT NULL DEFAULT 0 CHECK ("attempt" >= 0),
  "workspacePath" TEXT NOT NULL,
  "workspaceKey" TEXT NOT NULL,
  "approvedSpecHash" TEXT NOT NULL,
  "approvedExecutor" TEXT NOT NULL CHECK ("approvedExecutor" IN ('AUTO','FAKE','CODEX','CLAUDE')),
  "approvedModel" TEXT NOT NULL,
  "approvedEffort" TEXT NOT NULL CHECK ("approvedEffort" IN ('AUTO','LOW','MEDIUM','HIGH')),
  "approvedReviewer" TEXT NOT NULL CHECK ("approvedReviewer" IN ('NONE','AUTO','CODEX','CLAUDE')),
  "approvedPermissionsHash" TEXT NOT NULL,
  "approvedTimeoutSeconds" INTEGER NOT NULL DEFAULT 1800 CHECK ("approvedTimeoutSeconds" BETWEEN 60 AND 7200),
  "approvedVerificationJson" TEXT NOT NULL DEFAULT '[]' CHECK (json_valid("approvedVerificationJson")),
  "dirtyBaselineAcknowledgedHash" TEXT,
  "capsuleHash" TEXT,
  "capsuleJson" TEXT NOT NULL DEFAULT '{}' CHECK (json_valid("capsuleJson")),
  "baselineEvidenceJson" TEXT NOT NULL DEFAULT '{}' CHECK (json_valid("baselineEvidenceJson")),
  "finalEvidenceJson" TEXT NOT NULL DEFAULT '{}' CHECK (json_valid("finalEvidenceJson")),
  "processId" INTEGER CHECK ("processId" IS NULL OR "processId" > 0),
  "processStartedAt" DATETIME,
  "processIdentity" TEXT,
  "processExitCode" INTEGER,
  "processSignal" TEXT,
  "verificationResultsJson" TEXT NOT NULL DEFAULT '[]' CHECK (json_valid("verificationResultsJson")),
  "queuedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "claimedAt" DATETIME,
  "startedAt" DATETIME,
  "finishedAt" DATETIME,
  "cancelledAt" DATETIME,
  "timeoutAt" DATETIME,
  "heartbeatAt" DATETIME,
  "durationMs" INTEGER CHECK ("durationMs" IS NULL OR "durationMs" >= 0),
  "summary" TEXT NOT NULL DEFAULT '',
  "failureCode" TEXT,
  "failureMessage" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "ExecutionSession_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ExecutionSession_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "ExecutionSession_m22" (
  "id","taskId","projectId","executorId","executorConfigJson","status","attempt","workspacePath","workspaceKey",
  "approvedSpecHash","approvedExecutor","approvedModel","approvedEffort","approvedReviewer","approvedPermissionsHash",
  "queuedAt","claimedAt","startedAt","finishedAt","cancelledAt","timeoutAt","heartbeatAt","durationMs","summary",
  "failureCode","failureMessage","createdAt","updatedAt"
)
SELECT
  "id","taskId","projectId","executorId","executorConfigJson","status","attempt","workspacePath","workspaceKey",
  "approvedSpecHash","approvedExecutor","approvedModel","approvedEffort","approvedReviewer","approvedPermissionsHash",
  "queuedAt","claimedAt","startedAt","finishedAt","cancelledAt","timeoutAt","heartbeatAt","durationMs","summary",
  "failureCode","failureMessage","createdAt","updatedAt"
FROM "ExecutionSession";

DROP TABLE "ExecutionSession";
ALTER TABLE "ExecutionSession_m22" RENAME TO "ExecutionSession";

CREATE INDEX "ExecutionSession_status_queuedAt_idx" ON "ExecutionSession"("status", "queuedAt");
CREATE INDEX "ExecutionSession_taskId_createdAt_idx" ON "ExecutionSession"("taskId", "createdAt");
CREATE INDEX "ExecutionSession_workspaceKey_status_idx" ON "ExecutionSession"("workspaceKey", "status");
CREATE UNIQUE INDEX "ExecutionSession_one_active_task" ON "ExecutionSession"("taskId") WHERE "status" IN ('QUEUED','WAITING_FOR_WORKSPACE','CLAIMED','PREPARING','RUNNING','CANCELLATION_REQUESTED');

CREATE TABLE "ExecutionEvent_m22" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "sessionId" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL CHECK ("sequence" >= 1),
  "eventType" TEXT NOT NULL CHECK ("eventType" IN (
    'EXECUTION_REQUESTED','SESSION_QUEUED','SESSION_CLAIMED','WORKSPACE_WAITING','WORKSPACE_LOCKED',
    'EXECUTOR_PREPARING','EXECUTION_STARTED','OUTPUT_RECEIVED','WARNING_RECEIVED','CANCELLATION_REQUESTED',
    'EXECUTION_SUCCEEDED','EXECUTION_FAILED','EXECUTION_TIMED_OUT','EXECUTION_CANCELLED','WORKSPACE_RELEASED',
    'STALE_SESSION_RECOVERED','PROCESS_STARTED','GIT_BASELINE_CAPTURED','GIT_EVIDENCE_CAPTURED',
    'VERIFICATION_STARTED','VERIFICATION_COMPLETED'
  )),
  "level" TEXT NOT NULL CHECK ("level" IN ('DEBUG','INFO','WARNING','ERROR')),
  "message" TEXT NOT NULL,
  "payloadJson" TEXT NOT NULL CHECK (json_valid("payloadJson")),
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ExecutionEvent_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ExecutionSession"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "ExecutionEvent_m22" SELECT * FROM "ExecutionEvent";
DROP TABLE "ExecutionEvent";
ALTER TABLE "ExecutionEvent_m22" RENAME TO "ExecutionEvent";
CREATE UNIQUE INDEX "ExecutionEvent_sessionId_sequence_key" ON "ExecutionEvent"("sessionId", "sequence");
CREATE INDEX "ExecutionEvent_sessionId_createdAt_idx" ON "ExecutionEvent"("sessionId", "createdAt");
CREATE TRIGGER "ExecutionEvent_no_update" BEFORE UPDATE ON "ExecutionEvent"
BEGIN SELECT RAISE(ABORT, 'ExecutionEvent is append-only'); END;
CREATE TRIGGER "ExecutionEvent_no_delete" BEFORE DELETE ON "ExecutionEvent"
BEGIN SELECT RAISE(ABORT, 'ExecutionEvent is append-only'); END;

CREATE TABLE "ExecutionArtifact_m22" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "sessionId" TEXT NOT NULL,
  "artifactType" TEXT NOT NULL CHECK ("artifactType" IN ('LOG','CHANGED_FILES','CAPSULE','BASELINE_GIT','FINAL_GIT','PATCH','VERIFICATION')),
  "relativePath" TEXT NOT NULL CHECK (length("relativePath") > 0),
  "sha256" TEXT NOT NULL CHECK (length("sha256") = 64),
  "byteCount" INTEGER NOT NULL CHECK ("byteCount" >= 0),
  "truncated" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ExecutionArtifact_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ExecutionSession"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "ExecutionArtifact_m22" SELECT * FROM "ExecutionArtifact";
DROP TABLE "ExecutionArtifact";
ALTER TABLE "ExecutionArtifact_m22" RENAME TO "ExecutionArtifact";
CREATE UNIQUE INDEX "ExecutionArtifact_sessionId_artifactType_relativePath_key" ON "ExecutionArtifact"("sessionId", "artifactType", "relativePath");
CREATE INDEX "ExecutionArtifact_sessionId_createdAt_idx" ON "ExecutionArtifact"("sessionId", "createdAt");

CREATE TABLE "ExecutorCapabilitySnapshot" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "executorId" TEXT NOT NULL CHECK ("executorId" IN ('codex-cli')),
  "executablePath" TEXT NOT NULL,
  "displayPath" TEXT NOT NULL,
  "version" TEXT NOT NULL,
  "authenticationStatus" TEXT NOT NULL CHECK ("authenticationStatus" IN ('AUTHENTICATED','UNAUTHENTICATED','UNKNOWN','UNAVAILABLE')),
  "supported" BOOLEAN NOT NULL,
  "snapshotJson" TEXT NOT NULL CHECK (json_valid("snapshotJson")),
  "rawHelpHash" TEXT NOT NULL CHECK (length("rawHelpHash") = 64),
  "detectedAt" DATETIME NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "ExecutorCapabilitySnapshot_executorId_detectedAt_idx" ON "ExecutorCapabilitySnapshot"("executorId", "detectedAt");

PRAGMA foreign_key_check;
PRAGMA foreign_keys=ON;
