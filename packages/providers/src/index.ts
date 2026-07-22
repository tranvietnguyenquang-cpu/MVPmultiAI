import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { redactSecrets, validateWorkspace } from "@project-relay/execution";
import type { TaskCapsuleContent } from "@project-relay/shared";

export type ProviderStatus = { available: boolean; version?: string; setup?: string };
export type AgentSessionInput = { workspace: string; taskId: string };
export type AgentSession = { id: string; workspace: string; taskId: string };
export type AgentEvent = { type: "state" | "stdout" | "stderr"; message: string; timestamp: Date };
export type UsageReport = { estimated: true; inputTokens: number; outputTokens: number };

export interface CodingProvider {
  id: string;
  checkAvailability(): Promise<ProviderStatus>;
  createSession(input: AgentSessionInput): Promise<AgentSession>;
  sendTask(session: AgentSession, capsule: TaskCapsuleContent, signal?: AbortSignal): Promise<void>;
  streamEvents(sessionId: string): AsyncIterable<AgentEvent>;
  cancelSession(sessionId: string): Promise<void>;
  getUsage(sessionId: string): Promise<UsageReport>;
}

type SessionRecord = { events: AgentEvent[]; waiters: Array<() => void>; controller: AbortController; usage: UsageReport };

export class CodexCliProvider implements CodingProvider {
  readonly id = "codex";
  private readonly sessions = new Map<string, SessionRecord>();

  async checkAvailability(): Promise<ProviderStatus> {
    return await new Promise((resolve) => {
      const child = spawn("codex", ["--version"], { shell: false, windowsHide: true });
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
      child.once("error", () => resolve({ available: false, setup: "Install the Codex CLI and sign in with `codex login`. No ChatGPT password is stored by ProjectRelay." }));
      child.once("close", (code) => resolve(code === 0 ? { available: true, version: output.trim() } : { available: false, setup: "Run `codex --version`, then `codex login`." }));
    });
  }

  async createSession(input: AgentSessionInput): Promise<AgentSession> {
    const workspace = await validateWorkspace(input.workspace);
    const session = { id: randomUUID(), workspace, taskId: input.taskId };
    this.sessions.set(session.id, { events: [], waiters: [], controller: new AbortController(), usage: { estimated: true, inputTokens: 0, outputTokens: 0 } });
    return session;
  }

  async sendTask(session: AgentSession, capsule: TaskCapsuleContent, signal?: AbortSignal): Promise<void> {
    const record = this.sessions.get(session.id);
    if (!record) throw new Error("Unknown provider session.");
    const prompt = ["Continue the project using only the supplied structured state.", "Do not rely on earlier conversation history.", "Respect prohibited changes and report evidence.", JSON.stringify(capsule, null, 2)].join("\n\n");
    record.usage.inputTokens = Math.ceil(prompt.length / 4);
    const effectiveSignal = signal ?? record.controller.signal;
    await new Promise<void>((resolve, reject) => {
      const child = spawn("codex", ["exec", "--json", "--cd", session.workspace, "-"], { cwd: session.workspace, shell: false, windowsHide: true, env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(KEY|TOKEN|SECRET|PASSWORD|COOKIE|CREDENTIAL|DATABASE_URL)/i.test(key))) });
      const push = (type: "stdout" | "stderr", chunk: Buffer) => {
        const message = redactSecrets(chunk.toString("utf8"));
        record.events.push({ type, message, timestamp: new Date() });
        record.usage.outputTokens += Math.ceil(message.length / 4);
        record.waiters.splice(0).forEach((wake) => wake());
      };
      child.stdout.on("data", (chunk: Buffer) => push("stdout", chunk));
      child.stderr.on("data", (chunk: Buffer) => push("stderr", chunk));
      child.once("error", reject);
      child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`Codex exited with code ${String(code)}.`)));
      effectiveSignal.addEventListener("abort", () => child.kill(), { once: true });
      child.stdin.end(prompt);
    });
  }

  async *streamEvents(sessionId: string): AsyncIterable<AgentEvent> {
    const record = this.sessions.get(sessionId);
    if (!record) throw new Error("Unknown provider session.");
    let cursor = 0;
    while (!record.controller.signal.aborted) {
      while (cursor < record.events.length) yield record.events[cursor++]!;
      await new Promise<void>((resolve) => record.waiters.push(resolve));
    }
  }

  async cancelSession(sessionId: string): Promise<void> { const record=this.sessions.get(sessionId); record?.controller.abort(); record?.waiters.splice(0).forEach((wake)=>wake()); }
  async getUsage(sessionId: string): Promise<UsageReport> { return this.sessions.get(sessionId)?.usage ?? { estimated: true, inputTokens: 0, outputTokens: 0 }; }
}
