import { Queue } from "bullmq";
import type { SessionJob } from "@project-relay/shared";

const redisUrl = new URL(process.env.REDIS_URL ?? "redis://localhost:6379");
const connection = {
  host: redisUrl.hostname,
  port: Number(redisUrl.port || 6379),
  ...(redisUrl.password ? { password: decodeURIComponent(redisUrl.password) } : {})
};
let sessionQueue: Queue<SessionJob, void, "run"> | undefined;
export function getSessionQueue(): Queue<SessionJob, void, "run"> {
  if (!sessionQueue) sessionQueue = new Queue<SessionJob, void, "run">("agent-sessions", { connection });
  return sessionQueue;
}
