import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { inspectGit, resolveInsideWorkspace } from "@project-relay/execution";
import { readMemory } from "@project-relay/project-memory";
import { approximateTokens, type TaskCapsuleContent } from "@project-relay/shared";

type CapsuleInput = {
  workspace: string;
  task: { id: string; title: string; objective: string; userRequest: string; relevantFiles: string[]; prohibitedChanges: string[] };
  decisions: Array<{ id: string; title: string; decision: string; locked: boolean }>;
  criteria: Array<{ id: string; description: string }>;
  evidence: Array<{ kind: string; successful: boolean; output: string | null }>;
};

export async function createTaskCapsule(input: CapsuleInput): Promise<{ content: TaskCapsuleContent; approximateTokenCount: number }> {
  const sourceContext: Array<{ path: string; summary: string }> = [];
  for (const relativePath of input.task.relevantFiles.slice(0, 20)) {
    try {
      const file = await resolveInsideWorkspace(input.workspace, relativePath);
      const contents = await readFile(file, "utf8");
      sourceContext.push({ path: relativePath, summary: contents.slice(0, 8_000) });
    } catch (error) {
      sourceContext.push({ path: relativePath, summary: `Unavailable: ${error instanceof Error ? error.message : "unknown error"}` });
    }
  }
  const content: TaskCapsuleContent = {
    task: { id: input.task.id, title: input.task.title, objective: input.task.objective, userRequest: input.task.userRequest },
    architectureDecisions: input.decisions,
    codingRules: (await readMemory(input.workspace, "CODING_RULES.md")).slice(0, 12_000),
    sourceContext,
    knownIssues: (await readMemory(input.workspace, "KNOWN_ISSUES.md")).slice(0, 12_000),
    acceptanceCriteria: input.criteria,
    latestTestEvidence: input.evidence.slice(0, 10).map((item) => ({ kind: item.kind, successful: item.successful, summary: (item.output ?? "No output").slice(0, 2_000) })),
    prohibitedChanges: input.task.prohibitedChanges
  };
  return { content, approximateTokenCount: approximateTokens(content) };
}

export type ContextHealth = { estimatedTokens: number; tasksSinceCheckpoint: number; contradictions: string[]; unverifiedAssumptions: string[]; staleMemoryFiles: string[]; missingEvidence: number; gitStateMismatch: boolean; confidence: number };

export async function calculateContextHealth(input: { workspace: string; capsuleTokens: number; tasksSinceCheckpoint: number; missingEvidence: number; expectedCommit?: string | null | undefined }): Promise<ContextHealth> {
  const memoryRoot = path.join(input.workspace, ".ai-project");
  const staleMemoryFiles: string[] = [];
  for (const name of ["CURRENT_STATE.md", "CURRENT_TASK.md", "TEST_STATUS.md"] as const) {
    try { if (Date.now() - (await stat(path.join(memoryRoot, name))).mtimeMs > 7 * 86_400_000) staleMemoryFiles.push(name); } catch { staleMemoryFiles.push(name); }
  }
  const git = await inspectGit(input.workspace);
  const gitStateMismatch = Boolean(input.expectedCommit && git.commit && input.expectedCommit !== git.commit);
  const penalties = staleMemoryFiles.length * 7 + input.missingEvidence * 8 + (gitStateMismatch ? 20 : 0) + Math.max(0, input.tasksSinceCheckpoint - 5) * 3;
  return { estimatedTokens: input.capsuleTokens, tasksSinceCheckpoint: input.tasksSinceCheckpoint, contradictions: gitStateMismatch ? ["Checkpoint commit differs from current Git HEAD."] : [], unverifiedAssumptions: [], staleMemoryFiles, missingEvidence: input.missingEvidence, gitStateMismatch, confidence: Math.max(0, 100 - penalties) };
}

export async function createCheckpointContent(input: { workspace: string; projectSummary: string; architecture: string; decisions: unknown[]; lockedDecisions: unknown[]; completedTasks: unknown[]; currentTask: unknown; pendingTasks: unknown[]; knownIssues: string; testStatus: string; migrationStatus: string; assumptions: string[]; contradictions: string[]; recommendedNextAction: string }) {
  const git = await inspectGit(input.workspace);
  return { projectSummary: input.projectSummary, currentArchitecture: input.architecture, acceptedDecisions: input.decisions, lockedDecisions: input.lockedDecisions, completedTasksSincePreviousCheckpoint: input.completedTasks, currentTask: input.currentTask, pendingTasks: input.pendingTasks, knownIssues: input.knownIssues, git, testStatus: input.testStatus, databaseMigrationStatus: input.migrationStatus, recentImportantFileChanges: git.status.split("\n").filter(Boolean), unverifiedAssumptions: input.assumptions, contradictionsDetected: input.contradictions, recommendedNextAction: input.recommendedNextAction, createdAt: new Date().toISOString() };
}
