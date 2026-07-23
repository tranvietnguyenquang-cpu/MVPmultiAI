ALTER TABLE "Project"
  ADD COLUMN "verificationRunId" TEXT,
  ADD COLUMN "isVerification" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "Project_isVerification_verificationRunId_idx"
  ON "Project"("isVerification", "verificationRunId");
