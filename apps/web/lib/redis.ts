import { Queue } from "bullmq";
import type { SessionJob } from "@project-relay/shared";

const redisUrl = new URL(process.env.REDIS_URL ?? "redis://localhost:6379");
const connection = {
  host: redisUrl.hostname,
  port: Number(redisUrl.port || 6379),
  ...(redisUrl.password ? { password: decodeURIComponent(redisUrl.password) } : {})
};
let sessionQueue: Queue<SessionJob, void, "run"> | undefined;
let providerHealthQueue: Queue<{providerId:"codex-cli"|"claude-cli";mode:"refresh"|"auth"},void,"check">|undefined;
export function getSessionQueue(): Queue<SessionJob, void, "run"> {
  if (!sessionQueue) sessionQueue = new Queue<SessionJob, void, "run">("agent-sessions", { connection });
  return sessionQueue;
}
export function getProviderHealthQueue(){if(!providerHealthQueue)providerHealthQueue=new Queue("provider-health",{connection});return providerHealthQueue;}

export type ConversationMessageJob = { sessionId: string; taskId: string; conversationId: string; messageId: string; providerId: string };
let conversationMessageQueue: Queue<ConversationMessageJob, void, "route"> | undefined;
export function getConversationMessageQueue(): Queue<ConversationMessageJob, void, "route"> {
  if (!conversationMessageQueue) conversationMessageQueue = new Queue<ConversationMessageJob, void, "route">("conversation-messages", { connection });
  return conversationMessageQueue;
}
