-- Relay v2 Milestone 1 uses normalized TEXT values instead of connector-specific enums.
-- JSON-like values are canonical JSON stored as TEXT and validated by the application.
PRAGMA foreign_keys=OFF;

CREATE TABLE "Project" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "localPath" TEXT NOT NULL,
  "pathKey" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "defaultExecutor" TEXT NOT NULL DEFAULT 'AUTO' CHECK ("defaultExecutor" IN ('AUTO','CODEX','CLAUDE')),
  "defaultReviewer" TEXT NOT NULL DEFAULT 'AUTO' CHECK ("defaultReviewer" IN ('NONE','AUTO','CODEX','CLAUDE')),
  "defaultModel" TEXT NOT NULL DEFAULT 'AUTO',
  "defaultEffort" TEXT NOT NULL DEFAULT 'AUTO' CHECK ("defaultEffort" IN ('AUTO','LOW','MEDIUM','HIGH')),
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "Task" (
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
  "selectedExecutor" TEXT NOT NULL DEFAULT 'AUTO' CHECK ("selectedExecutor" IN ('AUTO','CODEX','CLAUDE')),
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
  CONSTRAINT "Task_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "TaskConstraint" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "taskId" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL CHECK ("ordinal" >= 0),
  "text" TEXT NOT NULL,
  CONSTRAINT "TaskConstraint_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "AcceptanceCriterion" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "taskId" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL CHECK ("ordinal" >= 0),
  "description" TEXT NOT NULL,
  CONSTRAINT "AcceptanceCriterion_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "TaskPermission" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "taskId" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL CHECK ("ordinal" >= 0),
  "permission" TEXT NOT NULL,
  "valueJson" TEXT NOT NULL CHECK (json_valid("valueJson")),
  CONSTRAINT "TaskPermission_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "Approval" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "taskId" TEXT NOT NULL,
  "approvalType" TEXT NOT NULL,
  "requestedBy" TEXT NOT NULL,
  "resolvedBy" TEXT,
  "status" TEXT NOT NULL DEFAULT 'PENDING' CHECK ("status" IN ('PENDING','APPROVED','REJECTED','INVALIDATED')),
  "specHash" TEXT NOT NULL,
  "approvedSpecJson" TEXT NOT NULL CHECK (json_valid("approvedSpecJson")),
  "executor" TEXT NOT NULL CHECK ("executor" IN ('AUTO','CODEX','CLAUDE')),
  "model" TEXT NOT NULL,
  "effort" TEXT NOT NULL CHECK ("effort" IN ('AUTO','LOW','MEDIUM','HIGH')),
  "reviewer" TEXT NOT NULL CHECK ("reviewer" IN ('NONE','AUTO','CODEX','CLAUDE')),
  "permissionsJson" TEXT NOT NULL CHECK (json_valid("permissionsJson")),
  "requestedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" DATETIME,
  "invalidatedAt" DATETIME,
  CONSTRAINT "Approval_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "AuditEvent" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "projectId" TEXT NOT NULL,
  "taskId" TEXT,
  "actor" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "riskLevel" TEXT NOT NULL CHECK ("riskLevel" IN ('SAFE','REVIEW','DANGEROUS','BLOCKED')),
  "detailsJson" TEXT NOT NULL CHECK (json_valid("detailsJson")),
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuditEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AuditEvent_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "ImportReport" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "projectId" TEXT,
  "reportType" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "sourceCountsJson" TEXT NOT NULL CHECK (json_valid("sourceCountsJson")),
  "candidateCountsJson" TEXT NOT NULL CHECK (json_valid("candidateCountsJson")),
  "skippedCountsJson" TEXT NOT NULL CHECK (json_valid("skippedCountsJson")),
  "reasonsJson" TEXT NOT NULL CHECK (json_valid("reasonsJson")),
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ImportReport_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "Project_slug_key" ON "Project"("slug");
CREATE UNIQUE INDEX "Project_pathKey_key" ON "Project"("pathKey");
CREATE UNIQUE INDEX "Task_projectId_source_idempotencyKey_key" ON "Task"("projectId", "source", "idempotencyKey");
CREATE UNIQUE INDEX "Task_projectId_source_externalId_key" ON "Task"("projectId", "source", "externalId");
CREATE INDEX "Task_projectId_status_createdAt_idx" ON "Task"("projectId", "status", "createdAt");
CREATE UNIQUE INDEX "TaskConstraint_taskId_ordinal_key" ON "TaskConstraint"("taskId", "ordinal");
CREATE UNIQUE INDEX "AcceptanceCriterion_taskId_ordinal_key" ON "AcceptanceCriterion"("taskId", "ordinal");
CREATE UNIQUE INDEX "TaskPermission_taskId_permission_key" ON "TaskPermission"("taskId", "permission");
CREATE UNIQUE INDEX "TaskPermission_taskId_ordinal_key" ON "TaskPermission"("taskId", "ordinal");
CREATE INDEX "Approval_taskId_status_requestedAt_idx" ON "Approval"("taskId", "status", "requestedAt");
CREATE INDEX "AuditEvent_projectId_createdAt_idx" ON "AuditEvent"("projectId", "createdAt");
CREATE INDEX "AuditEvent_taskId_createdAt_idx" ON "AuditEvent"("taskId", "createdAt");
CREATE INDEX "ImportReport_projectId_createdAt_idx" ON "ImportReport"("projectId", "createdAt");

CREATE TRIGGER "AuditEvent_no_update"
BEFORE UPDATE ON "AuditEvent"
BEGIN
  SELECT RAISE(ABORT, 'AuditEvent is append-only');
END;

CREATE TRIGGER "AuditEvent_no_delete"
BEFORE DELETE ON "AuditEvent"
BEGIN
  SELECT RAISE(ABORT, 'AuditEvent is append-only');
END;

PRAGMA foreign_keys=ON;
