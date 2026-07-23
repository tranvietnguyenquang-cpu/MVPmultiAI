import { prisma } from "./index.js";

const LEGACY_PREFIXES = [
  "worker-relationships-", "worker-lease-test-", "worker-lease-legacy-", "conversation-resume-test-",
  "conversation-worker-test-", "conversation-worker-exec-test-", "conversation-message-test-",
  "conversation-api-test-", "conversation-service-test-", "concurrency-test-", "sanitization-test-",
  "auth-boundary-", "outbox-test-", "archived-project-", "e2e-"
] as const;
const TEMP_ROOT = /^(?:\/tmp\/|[A-Za-z]:\\Users\\[^\\]+\\AppData\\Local\\Temp\\project-relay-e2e-)/i;

export type VerificationCleanupPreview = {
  projects: Array<{ id: string; name: string; repositoryPath: string; reason: string }>;
  refused: Array<{ id: string; name: string; repositoryPath: string }>;
  counts: { projects: number; conversations: number; messages: number; providerSessions: number; agentSessions: number; routingDecisions: number; handoffCapsules: number; outboxEvents: number; checkpoints: number; queueJobs: number };
  queueJobIds: string[];
};

function ownership(project: { name: string; repositoryPath: string; isVerification: boolean; verificationRunId: string | null }): string | null {
  if (project.isVerification || project.verificationRunId) return "explicit verification ownership metadata";
  if (LEGACY_PREFIXES.some(prefix => project.name.startsWith(prefix)) && TEMP_ROOT.test(project.repositoryPath)) return "known verification prefix under verification temporary root";
  return null;
}

export async function previewVerificationCleanup(): Promise<VerificationCleanupPreview> {
  const projects = await prisma.project.findMany({ select: { id: true, name: true, repositoryPath: true, isVerification: true, verificationRunId: true } });
  const selected = projects.flatMap(project => {
    const reason = ownership(project);
    return reason ? [{ id: project.id, name: project.name, repositoryPath: project.repositoryPath, reason }] : [];
  });
  // A verification-looking name outside the disposable root is intentionally refused, never guessed.
  const refused = projects.filter(project => LEGACY_PREFIXES.some(prefix => project.name.startsWith(prefix)) && !ownership(project)).map(({ id, name, repositoryPath }) => ({ id, name, repositoryPath }));
  const projectIds = selected.map(project => project.id);
  const conversationIds = (await prisma.conversation.findMany({ where: { projectId: { in: projectIds } }, select: { id: true } })).map(row => row.id);
  const agentSessions = await prisma.agentSession.findMany({ where: { projectId: { in: projectIds } }, select: { id: true } });
  const sessionIds = agentSessions.map(row => row.id);
  const [messages, providerSessions, routingDecisions, handoffCapsules, outboxEvents, checkpoints] = await Promise.all([
    prisma.conversationMessage.count({ where: { conversationId: { in: conversationIds } } }),
    prisma.providerSession.count({ where: { conversationId: { in: conversationIds } } }),
    prisma.routingDecision.count({ where: { conversationId: { in: conversationIds } } }),
    prisma.handoffCapsule.count({ where: { conversationId: { in: conversationIds } } }),
    prisma.outboxEvent.count({ where: { jobId: { in: sessionIds } } }),
    prisma.checkpoint.count({ where: { projectId: { in: projectIds } } })
  ]);
  return { projects: selected, refused, counts: { projects: selected.length, conversations: conversationIds.length, messages, providerSessions, agentSessions: sessionIds.length, routingDecisions, handoffCapsules, outboxEvents, checkpoints, queueJobs: sessionIds.length }, queueJobIds: sessionIds };
}

/** Deletes only the IDs returned by a fresh, fully proven preview. Queue jobs are removed by the caller using `queueJobIds`. */
export async function commitVerificationCleanup(): Promise<VerificationCleanupPreview> {
  const preview = await previewVerificationCleanup();
  if (preview.refused.length) throw new Error("Refusing cleanup because a verification-looking project is not provably disposable.");
  await prisma.$transaction(async tx => {
    const current = await tx.project.findMany({ where: { id: { in: preview.projects.map(project => project.id) } }, select: { id: true, name: true, repositoryPath: true, isVerification: true, verificationRunId: true } });
    if (current.some(project => !ownership(project))) throw new Error("Refusing cleanup because ownership changed before deletion.");
    const projectIds = current.map(project => project.id);
    const conversationIds = (await tx.conversation.findMany({ where: { projectId: { in: projectIds } }, select: { id: true } })).map(row => row.id);
    const sessionIds = (await tx.agentSession.findMany({ where: { projectId: { in: projectIds } }, select: { id: true } })).map(row => row.id);
    await tx.outboxEvent.deleteMany({ where: { jobId: { in: sessionIds } } });
    // Messages may reference tasks with Restrict, so clear them before cascaded project deletion.
    await tx.conversationMessage.deleteMany({ where: { conversationId: { in: conversationIds } } });
    await tx.project.deleteMany({ where: { id: { in: projectIds } } });
  });
  return preview;
}
