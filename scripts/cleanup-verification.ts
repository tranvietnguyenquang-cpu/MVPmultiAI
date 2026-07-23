import { Queue } from "bullmq";
import { commitVerificationCleanup, previewVerificationCleanup, prisma } from "@project-relay/database";

void (async () => {
const commit = process.argv.includes("--commit");
const preview = await previewVerificationCleanup();
console.log(JSON.stringify({ dryRun: !commit, projects: preview.projects, refused: preview.refused, counts: preview.counts }, null, 2));
if (preview.refused.length) process.exitCode = 2;
else if (commit) {
  const redisUrl = new URL(process.env.REDIS_URL ?? "redis://127.0.0.1:6379");
  const queue = new Queue("conversation-messages", { connection: { host: redisUrl.hostname, port: Number(redisUrl.port || 6379), ...(redisUrl.password ? { password: decodeURIComponent(redisUrl.password) } : {}) } });
  let removed = 0;
  for (const id of preview.queueJobIds) { const job = await queue.getJob(id); if (job) { await job.remove(); removed++; } }
  await queue.close();
  await commitVerificationCleanup();
  console.log(JSON.stringify({ committed: true, removedQueueJobs: removed }));
}
await prisma.$disconnect();
})();
