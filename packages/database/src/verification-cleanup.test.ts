import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { prisma } from "./index.js";
import { commitVerificationCleanup, previewVerificationCleanup } from "./verification-cleanup.js";

const ids: string[] = [];
async function project(input: { name: string; repositoryPath: string; isVerification?: boolean; verificationRunId?: string }) {
  const created = await prisma.project.create({ data: { ...input, allowedCommands: [], permittedPaths: [], isVerification: input.isVerification ?? false } });
  ids.push(created.id); return created;
}
afterEach(async () => { await prisma.project.deleteMany({ where: { id: { in: ids.splice(0) } } }).catch(() => undefined); });

describe("verification cleanup", () => {
  it("dry-run changes nothing and reports exact related counts", async () => {
    const p = await project({ name: `worker-relationships-${randomUUID()}`, repositoryPath: `/tmp/worker-relationships-${randomUUID()}` });
    const c = await prisma.conversation.create({ data: { projectId: p.id, title: "verification" } });
    await prisma.conversationMessage.create({ data: { conversationId: c.id, role: "USER", mode: "ASK", content: "test" } });
    const preview = await previewVerificationCleanup();
    expect(preview.projects.some(row => row.id === p.id)).toBe(true);
    expect(preview.counts.messages).toBeGreaterThan(0);
    expect(await prisma.project.findUnique({ where: { id: p.id } })).not.toBeNull();
  });
  it("commits only explicitly owned verification projects", async () => {
    const disposable = await project({ name: `ordinary-${randomUUID()}`, repositoryPath: "C:\\safe\\not-a-temp", isVerification: true, verificationRunId: randomUUID() });
    const real = await project({ name: `real-${randomUUID()}`, repositoryPath: "C:\\WebManageSchool" });
    await commitVerificationCleanup();
    expect(await prisma.project.findUnique({ where: { id: disposable.id } })).toBeNull();
    expect(await prisma.project.findUnique({ where: { id: real.id } })).not.toBeNull();
  });
  it("refuses ambiguous verification-looking records", async () => {
    await project({ name: `worker-relationships-${randomUUID()}`, repositoryPath: "C:\\real-project" });
    const preview = await previewVerificationCleanup();
    expect(preview.refused.length).toBeGreaterThan(0);
    await expect(commitVerificationCleanup()).rejects.toThrow(/Refusing cleanup/);
  });
  it("cleans an orphaned failed-run record on the next cleanup", async () => {
    const stale = await project({ name: `e2e-${randomUUID()}`, repositoryPath: "C:\\Users\\tester\\AppData\\Local\\Temp\\project-relay-e2e-stale", isVerification: true, verificationRunId: "failed-run" });
    await commitVerificationCleanup();
    expect(await prisma.project.findUnique({ where: { id: stale.id } })).toBeNull();
  });
});
