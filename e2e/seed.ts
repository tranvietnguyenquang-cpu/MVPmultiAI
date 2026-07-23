import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "@project-relay/database";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function e2eWorkspace(): string {
  const manifest = path.join(__dirname, ".e2e-workspace.json");
  const { workspace } = JSON.parse(readFileSync(manifest, "utf8")) as { workspace: string };
  return workspace;
}

export function e2eRunId(): string {
  const manifest = path.join(__dirname, ".e2e-workspace.json");
  const { runId } = JSON.parse(readFileSync(manifest, "utf8")) as { runId: string };
  return runId;
}

export async function createProject(name = `e2e-${randomUUID()}`) {
  return prisma.project.create({ data: { name, repositoryPath: e2eWorkspace(), allowedCommands: [], permittedPaths: [], isVerification: true, verificationRunId: e2eRunId() } });
}

export async function createConversation(projectId: string, title: string) {
  return prisma.conversation.create({ data: { projectId, title } });
}

export async function seedTurn(input: {
  conversationId: string;
  role: "USER" | "ASSISTANT";
  providerId?: string;
  content: string;
  status?: "COMPLETED" | "FAILED";
  agentSessionId?: string;
}) {
  return prisma.conversationMessage.create({
    data: {
      conversationId: input.conversationId,
      role: input.role,
      providerId: input.providerId ?? null,
      mode: "ASK",
      content: input.content,
      status: input.status ?? "COMPLETED",
      ...(input.agentSessionId ? { agentSessionId: input.agentSessionId } : {})
    }
  });
}

/** The real browser POST already created a genuine QUEUED AgentSession; fetch it rather than scraping the DOM (nothing exposes the id while pending). */
export async function waitForAgentSession(conversationId: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const session = await prisma.agentSession.findFirst({ where: { conversationId }, orderBy: { createdAt: "desc" } });
    if (session) return session;
    if (Date.now() > deadline) throw new Error(`No AgentSession appeared for conversation ${conversationId} within ${timeoutMs}ms.`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

export async function cleanupProject(projectId: string) {
  // ConversationMessage.taskId is RESTRICT, so clear messages before deleting the project
  // (which would otherwise fail to cascade through the auto-created Task rows).
  const conversations = await prisma.conversation.findMany({ where: { projectId }, select: { id: true } });
  await prisma.conversationMessage.deleteMany({ where: { conversationId: { in: conversations.map(c => c.id) } } });
  await prisma.project.delete({ where: { id: projectId } }).catch(() => undefined);
}
