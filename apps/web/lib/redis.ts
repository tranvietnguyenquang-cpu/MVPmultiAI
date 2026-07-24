import { Queue } from "bullmq";
import { assertDisposableRedisUrl, type SessionJob } from "@project-relay/shared";

// See packages/database/src/index.ts for why these two flags are the fail-closed signal
// that this process is automated tests/verification rather than the real dev:local app.
if (process.env.VITEST === "true" || process.env.PROJECT_RELAY_TEST_MODE === "true") {
  assertDisposableRedisUrl(process.env.REDIS_URL);
}

const redisUrl = new URL(process.env.REDIS_URL ?? "redis://localhost:6379");
const connection = {
  host: redisUrl.hostname,
  port: Number(redisUrl.port || 6379),
  ...(redisUrl.password ? { password: decodeURIComponent(redisUrl.password) } : {})
};
// Isolates test-run job keys from any other consumer of this Redis instance (and from a
// prior/concurrent test run) without needing a second Redis instance. Unset in normal use.
const prefix = process.env.PROJECT_RELAY_QUEUE_PREFIX;
const queueOptions = prefix ? { connection, prefix } : { connection };
let sessionQueue: Queue<SessionJob, void, "run"> | undefined;
let providerHealthQueue: Queue<{providerId:"codex-cli"|"claude-cli";mode:"refresh"|"auth"},void,"check">|undefined;
export function getSessionQueue(): Queue<SessionJob, void, "run"> {
  if (!sessionQueue) sessionQueue = new Queue<SessionJob, void, "run">("agent-sessions", queueOptions);
  return sessionQueue;
}
export function getProviderHealthQueue(){if(!providerHealthQueue)providerHealthQueue=new Queue("provider-health",queueOptions);return providerHealthQueue;}
