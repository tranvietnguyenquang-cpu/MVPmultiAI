import { randomUUID } from "node:crypto";
import { canonicalJson } from "@project-relay/relay-v2-domain";
import type { RelayV2Database } from "@project-relay/relay-v2-persistence";

export type LegacyProjectPreview = {
  id: string;
  name: string;
  tasks: Array<{ id: string; status: string }>;
  approvalCount: number;
};

export type LegacyReadOnlyReader = {
  readProjects(ids: string[]): Promise<LegacyProjectPreview[]>;
};

const safeMappings: Record<string, string> = {
  PLANNED: "PENDING_APPROVAL",
  BLOCKED: "BLOCKED",
  VERIFIED: "COMPLETED",
  CANCELLED: "CANCELLED"
};

export async function createLegacyPreviewReport(input: {
  database: RelayV2Database;
  reader: LegacyReadOnlyReader;
  v2ProjectId: string;
  legacyProjectIds: string[];
  actor?: string;
}) {
  const v2Project = await input.database.project.findUnique({ where: { id: input.v2ProjectId } });
  if (!v2Project) throw new Error("Relay v2 project not found.");
  const projects = await input.reader.readProjects([...new Set(input.legacyProjectIds)]);
  const tasks = projects.flatMap(project => project.tasks.map(task => ({ ...task, projectId: project.id, projectName: project.name })));
  const candidates = tasks.filter(task => safeMappings[task.status]);
  const skipped = tasks.filter(task => !safeMappings[task.status]);
  const legacyApprovalCount = projects.reduce((sum, project) => sum + project.approvalCount, 0);
  const reasons = [
    ...skipped.map(task => ({ taskId: task.id, reason: `Legacy state ${task.status} is ambiguous and is excluded from automatic import.` })),
    ...(legacyApprovalCount ? [{ reason: `${legacyApprovalCount} legacy approval record(s) are report-only and never become Relay v2 authorization.` }] : [])
  ];
  const sourceCounts = { projects: projects.length, tasks: tasks.length, approvals: legacyApprovalCount };
  const candidateCounts = { projects: projects.length, tasks: candidates.length };
  const skippedCounts = { projects: 0, tasks: skipped.length, approvals: legacyApprovalCount };

  return input.database.$transaction(async tx => {
    const report = await tx.importReport.create({ data: {
      id: randomUUID(),
      projectId: v2Project.id,
      reportType: "LEGACY_IMPORT_PREVIEW",
      status: "PREVIEW_ONLY",
      sourceCountsJson: canonicalJson(sourceCounts),
      candidateCountsJson: canonicalJson(candidateCounts),
      skippedCountsJson: canonicalJson(skippedCounts),
      reasonsJson: canonicalJson(reasons)
    } });
    await tx.auditEvent.create({ data: {
      id: randomUUID(),
      projectId: v2Project.id,
      actor: input.actor ?? "local-user",
      action: "LEGACY_REPORT_ATTEMPTED",
      riskLevel: "SAFE",
      detailsJson: canonicalJson({ reportId: report.id, legacyProjectIds: projects.map(project => project.id), sourceCounts, candidateCounts, skippedCounts })
    } });
    return {
      report,
      sourceCounts,
      candidateCounts,
      skippedCounts,
      reasons,
      candidates: candidates.map(task => ({ legacyTaskId: task.id, legacyProjectId: task.projectId, proposedStatus: safeMappings[task.status]!, imported: false }))
    };
  });
}
