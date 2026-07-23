import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "./index.js";
import { commitVerificationCleanup, previewVerificationCleanup } from "./verification-cleanup.js";

const testRunIds: string[] = [];
let testRunId = "";
let projectIds: string[] = [];

function assertDisposableDatabase(): void {
  const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
  const loopback = databaseUrl.hostname === "127.0.0.1" || databaseUrl.hostname === "localhost";
  if (!loopback || databaseUrl.port !== "55432") {
    throw new Error("Verification cleanup tests require the disposable validation database.");
  }
}

async function deleteTestRun(runId: string): Promise<void> {
  const projects = await prisma.project.findMany({
    where: { verificationRunId: runId, isVerification: true },
    select: { id: true },
  });
  const ids = projects.map((project) => project.id);
  if (!ids.length) return;

  await prisma.$transaction(async (tx) => {
    const sessionIds = (await tx.agentSession.findMany({
      where: { projectId: { in: ids } },
      select: { id: true },
    })).map((session) => session.id);
    await tx.outboxEvent.deleteMany({ where: { jobId: { in: sessionIds } } });
    await tx.project.deleteMany({ where: { id: { in: ids }, verificationRunId: runId, isVerification: true } });
  });
}

async function project(label: string, input: { isVerification?: boolean; real?: boolean } = {}) {
  const created = await prisma.project.create({
    data: {
      name: input.real ? `real-${testRunId}-${label}` : `verification-${testRunId}-${label}`,
      repositoryPath: input.real
        ? `C:\\real-project-${testRunId}-${label}`
        : `C:\\Users\\tester\\AppData\\Local\\Temp\\project-relay-e2e-${testRunId}-${label}`,
      allowedCommands: [],
      permittedPaths: [],
      isVerification: input.isVerification ?? !input.real,
      ...(input.real ? {} : { verificationRunId: testRunId }),
    },
  });
  projectIds.push(created.id);
  return created;
}

beforeEach(() => {
  assertDisposableDatabase();
  testRunId = `verification-cleanup-${randomUUID()}`;
  testRunIds.push(testRunId);
  projectIds = [];
});

afterEach(async () => {
  await deleteTestRun(testRunId);
  await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
  expect(await prisma.project.count({ where: { verificationRunId: testRunId } })).toBe(0);
});

afterAll(async () => {
  await Promise.all(testRunIds.map((runId) => deleteTestRun(runId)));
});

describe("verification cleanup", () => {
  it("dry-run changes nothing and reports exact related counts", async () => {
    const disposable = await project("dry-run");
    const conversation = await prisma.conversation.create({ data: { projectId: disposable.id, title: "verification" } });
    await prisma.conversationMessage.create({ data: { conversationId: conversation.id, role: "USER", mode: "ASK", content: "test" } });

    const preview = await previewVerificationCleanup();

    expect(preview.projects.some((row) => row.id === disposable.id)).toBe(true);
    expect(preview.counts.messages).toBeGreaterThan(0);
    expect(await prisma.project.findUnique({ where: { id: disposable.id } })).not.toBeNull();
  });

  it("commits only explicitly owned verification projects", async () => {
    const disposable = await project("owned");
    const real = await project("real", { real: true });

    await commitVerificationCleanup();

    expect(await prisma.project.findUnique({ where: { id: disposable.id } })).toBeNull();
    expect(await prisma.project.findUnique({ where: { id: real.id } })).not.toBeNull();
  });

  it("refuses ambiguous verification-looking records", async () => {
    const ambiguous = await prisma.project.create({
      data: {
        name: `worker-relationships-${testRunId}`,
        repositoryPath: `C:\\real-project-${testRunId}`,
        allowedCommands: [],
        permittedPaths: [],
      },
    });
    projectIds.push(ambiguous.id);

    const preview = await previewVerificationCleanup();

    expect(preview.refused.some((project) => project.id === ambiguous.id)).toBe(true);
    await expect(commitVerificationCleanup()).rejects.toThrow(/Refusing cleanup/);
  });

  it("cleans an orphaned failed-run record on the next cleanup", async () => {
    const stale = await project("failed-run");

    await commitVerificationCleanup();

    expect(await prisma.project.findUnique({ where: { id: stale.id } })).toBeNull();
  });

  it("runs the affected fixture twice without collisions or leftover records", async () => {
    for (const label of ["first", "second"]) {
      const disposable = await project(label);
      const conversation = await prisma.conversation.create({ data: { projectId: disposable.id, title: label } });
      await prisma.conversationMessage.create({ data: { conversationId: conversation.id, role: "USER", mode: "ASK", content: label } });
      await commitVerificationCleanup();

      expect(await prisma.project.findUnique({ where: { id: disposable.id } })).toBeNull();
      expect(await prisma.conversation.count({ where: { projectId: disposable.id } })).toBe(0);
    }
    expect(await prisma.project.count({ where: { verificationRunId: testRunId } })).toBe(0);
  });
});
