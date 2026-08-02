ALTER TABLE "AuditEvent" ADD COLUMN "executionSessionId" TEXT REFERENCES "ExecutionSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "ExecutionSession" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "taskId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "executorId" TEXT NOT NULL CHECK ("executorId" = 'fake'),
  "executorConfigJson" TEXT NOT NULL DEFAULT '{}' CHECK (json_valid("executorConfigJson")),
  "status" TEXT NOT NULL DEFAULT 'QUEUED' CHECK ("status" IN ('QUEUED','WAITING_FOR_WORKSPACE','CLAIMED','PREPARING','RUNNING','CANCELLATION_REQUESTED','SUCCEEDED','FAILED','TIMED_OUT','CANCELLED','BLOCKED')),
  "attempt" INTEGER NOT NULL DEFAULT 0 CHECK ("attempt" >= 0),
  "workspacePath" TEXT NOT NULL,
  "workspaceKey" TEXT NOT NULL,
  "approvedSpecHash" TEXT NOT NULL,
  "approvedExecutor" TEXT NOT NULL CHECK ("approvedExecutor" IN ('AUTO','CODEX','CLAUDE')),
  "approvedModel" TEXT NOT NULL,
  "approvedEffort" TEXT NOT NULL CHECK ("approvedEffort" IN ('AUTO','LOW','MEDIUM','HIGH')),
  "approvedReviewer" TEXT NOT NULL CHECK ("approvedReviewer" IN ('NONE','AUTO','CODEX','CLAUDE')),
  "approvedPermissionsHash" TEXT NOT NULL,
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

CREATE TABLE "ExecutionEvent" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "sessionId" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL CHECK ("sequence" >= 1),
  "eventType" TEXT NOT NULL CHECK ("eventType" IN ('EXECUTION_REQUESTED','SESSION_QUEUED','SESSION_CLAIMED','WORKSPACE_WAITING','WORKSPACE_LOCKED','EXECUTOR_PREPARING','EXECUTION_STARTED','OUTPUT_RECEIVED','WARNING_RECEIVED','CANCELLATION_REQUESTED','EXECUTION_SUCCEEDED','EXECUTION_FAILED','EXECUTION_TIMED_OUT','EXECUTION_CANCELLED','WORKSPACE_RELEASED','STALE_SESSION_RECOVERED')),
  "level" TEXT NOT NULL CHECK ("level" IN ('DEBUG','INFO','WARNING','ERROR')),
  "message" TEXT NOT NULL,
  "payloadJson" TEXT NOT NULL CHECK (json_valid("payloadJson")),
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ExecutionEvent_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ExecutionSession"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "ExecutionArtifact" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "sessionId" TEXT NOT NULL,
  "artifactType" TEXT NOT NULL CHECK ("artifactType" IN ('LOG','CHANGED_FILES')),
  "relativePath" TEXT NOT NULL CHECK (length("relativePath") > 0),
  "sha256" TEXT NOT NULL CHECK (length("sha256") = 64),
  "byteCount" INTEGER NOT NULL CHECK ("byteCount" >= 0),
  "truncated" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ExecutionArtifact_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ExecutionSession"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "WorkspaceLease" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "workspaceKey" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "leaseToken" TEXT NOT NULL,
  "acquiredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "heartbeatAt" DATETIME NOT NULL,
  "expiresAt" DATETIME NOT NULL,
  "releasedAt" DATETIME,
  CONSTRAINT "WorkspaceLease_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ExecutionSession"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "ExecutionSession_status_queuedAt_idx" ON "ExecutionSession"("status", "queuedAt");
CREATE INDEX "ExecutionSession_taskId_createdAt_idx" ON "ExecutionSession"("taskId", "createdAt");
CREATE INDEX "ExecutionSession_workspaceKey_status_idx" ON "ExecutionSession"("workspaceKey", "status");
CREATE UNIQUE INDEX "ExecutionSession_one_active_task" ON "ExecutionSession"("taskId") WHERE "status" IN ('QUEUED','WAITING_FOR_WORKSPACE','CLAIMED','PREPARING','RUNNING','CANCELLATION_REQUESTED');
CREATE UNIQUE INDEX "ExecutionEvent_sessionId_sequence_key" ON "ExecutionEvent"("sessionId", "sequence");
CREATE INDEX "ExecutionEvent_sessionId_createdAt_idx" ON "ExecutionEvent"("sessionId", "createdAt");
CREATE UNIQUE INDEX "ExecutionArtifact_sessionId_artifactType_relativePath_key" ON "ExecutionArtifact"("sessionId", "artifactType", "relativePath");
CREATE INDEX "ExecutionArtifact_sessionId_createdAt_idx" ON "ExecutionArtifact"("sessionId", "createdAt");
CREATE INDEX "WorkspaceLease_workspaceKey_releasedAt_idx" ON "WorkspaceLease"("workspaceKey", "releasedAt");
CREATE INDEX "WorkspaceLease_sessionId_releasedAt_idx" ON "WorkspaceLease"("sessionId", "releasedAt");
CREATE INDEX "WorkspaceLease_expiresAt_releasedAt_idx" ON "WorkspaceLease"("expiresAt", "releasedAt");
CREATE UNIQUE INDEX "WorkspaceLease_one_active_workspace" ON "WorkspaceLease"("workspaceKey") WHERE "releasedAt" IS NULL;
CREATE UNIQUE INDEX "WorkspaceLease_one_active_session" ON "WorkspaceLease"("sessionId") WHERE "releasedAt" IS NULL;
CREATE INDEX "AuditEvent_executionSessionId_createdAt_idx" ON "AuditEvent"("executionSessionId", "createdAt");

CREATE TRIGGER "ExecutionEvent_no_update" BEFORE UPDATE ON "ExecutionEvent"
BEGIN SELECT RAISE(ABORT, 'ExecutionEvent is append-only'); END;

CREATE TRIGGER "ExecutionEvent_no_delete" BEFORE DELETE ON "ExecutionEvent"
BEGIN SELECT RAISE(ABORT, 'ExecutionEvent is append-only'); END;
