import { prisma } from "@project-relay/database";

export async function findAccessibleProject(projectId: string) {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  return project && !project.archivedAt ? project : null;
}
