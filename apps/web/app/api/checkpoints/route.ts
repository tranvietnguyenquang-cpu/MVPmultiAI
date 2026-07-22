import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { Prisma, prisma } from "@project-relay/database";
import { createCheckpointContent } from "@project-relay/context-engine";
import { readMemory, writeCheckpointFile } from "@project-relay/project-memory";

export async function POST(request: Request) {
  try {
    const { projectId, taskId, reason } = await request.json() as { projectId?: string; taskId?: string; reason?: string };
    if (!projectId) throw new Error("projectId is required.");
    const project = await prisma.project.findUnique({ where: { id: projectId }, include: { decisions: true, tasks: { orderBy: { updatedAt: "desc" } } } });
    if (!project) throw new Error("Project not found.");
    const currentTask = project.tasks.find((task) => task.id === taskId) ?? project.tasks.find((task) => task.status === "IN_PROGRESS") ?? null;
    const content = await createCheckpointContent({
      workspace: project.repositoryPath,
      projectSummary: await readMemory(project.repositoryPath, "PROJECT.md"),
      architecture: await readMemory(project.repositoryPath, "ARCHITECTURE.md"),
      decisions: project.decisions.filter((decision) => decision.status === "ACCEPTED"),
      lockedDecisions: project.decisions.filter((decision) => decision.locked && decision.status === "ACCEPTED"),
      completedTasks: project.tasks.filter((task) => task.status === "VERIFIED"),
      currentTask,
      pendingTasks: project.tasks.filter((task) => ["PLANNED", "BLOCKED", "IN_PROGRESS"].includes(task.status)),
      knownIssues: await readMemory(project.repositoryPath, "KNOWN_ISSUES.md"),
      testStatus: await readMemory(project.repositoryPath, "TEST_STATUS.md"),
      migrationStatus: await readMemory(project.repositoryPath, "DATABASE.md"),
      assumptions: [], contradictions: [],
      recommendedNextAction: currentTask ? "Collect evidence for all acceptance criteria and verify the current task." : "Select the next planned task."
    });
    const id = randomUUID();
    const filePath = await writeCheckpointFile(project.repositoryPath, id, content);
    const checkpoint = await prisma.checkpoint.create({ data: { id, projectId: project.id, reason: reason ?? "Manual", content: content as Prisma.InputJsonValue, filePath, gitCommit: content.git.commit, gitBranch: content.git.branch, dirty: content.git.dirty } });
    return NextResponse.json(checkpoint, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not create checkpoint." }, { status: 400 });
  }
}
