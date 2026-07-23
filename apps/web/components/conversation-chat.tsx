"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { csrfFetch } from "../lib/csrf-client";

export type ConversationMessageView = {
  id: string;
  role: "USER" | "ASSISTANT" | "SYSTEM" | "TOOL";
  providerId: string | null;
  providerSessionId: string | null;
  agentSessionId: string | null;
  taskId: string | null;
  mode: "ASK" | "IMPLEMENT" | "REVIEW" | "CONTINUE" | "VERIFY";
  content: string;
  status: "QUEUED" | "RUNNING" | "COMPLETED" | "CANCELLED" | "FAILED";
  handoffCapsuleId: string | null;
  createdAt: string;
  routing?: { requestedProviderId: string | null; selectedProviderId: string };
};

export type HandoffCapsuleView = {
  id: string;
  fromProviderId: string;
  toProviderId: string;
  version: number;
  checksum: string;
  sourceMessageRange: { fromMessageId: string; toMessageId: string };
  sizeBytes: number;
  createdAt: string;
};

export type ProviderSessionView = { id: string; providerId: string; status: string; externalSessionId: string | null };
export type ProviderHealthView = { installed: boolean; authentication: string; available: boolean; version: string | null };

type ExecutionEventView = { id: string; type: string; stream: string | null; message: string; createdAt: string };
type ExecutionStateResponse = {
  status: string;
  selectedProvider: string;
  providerSession: ProviderSessionView | null;
  events: ExecutionEventView[];
  assistantMessage: ConversationMessageView | null;
  error: string | null;
};

const TERMINAL_STATES = new Set(["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT"]);
const STATUS_LABELS: Record<string, string> = {
  QUEUED: "QUEUED",
  STARTING: "STARTING",
  RUNNING: "RUNNING",
  WAITING_FOR_APPROVAL: "WAITING FOR APPROVAL",
  SUCCEEDED: "COMPLETED",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
  TIMED_OUT: "TIMED OUT"
};
const PROVIDER_LABELS: Record<string, string> = { "codex-cli": "Codex", "claude-cli": "Claude" };

function providerLabel(providerId: string | null): string {
  if (!providerId) return "—";
  return PROVIDER_LABELS[providerId] ?? providerId;
}

function formatTimestamp(value: string): string {
  return new Date(value).toLocaleString();
}

type PendingExecution = { id: string; status: string; events: ExecutionEventView[]; error: string | null };

export function ConversationChat(props: {
  projectId: string;
  conversationId: string;
  conversationTitle: string;
  messages: ConversationMessageView[];
  handoffCapsules: HandoffCapsuleView[];
  providerSessions: ProviderSessionView[];
  providerHealth: Record<string, ProviderHealthView>;
  initialActiveExecutionId: string | null;
}) {
  const router = useRouter();
  const { projectId, conversationId, messages, handoffCapsules, providerHealth } = props;

  const [content, setContent] = useState("");
  const [provider, setProvider] = useState<"auto" | "codex-cli" | "claude-cli">("auto");
  const [mode, setMode] = useState<"ASK" | "IMPLEMENT" | "REVIEW" | "CONTINUE" | "VERIFY">("ASK");
  const [submitting, setSubmitting] = useState(false);
  const [composerError, setComposerError] = useState("");
  const [pending, setPending] = useState<PendingExecution | null>(
    props.initialActiveExecutionId ? { id: props.initialActiveExecutionId, status: "QUEUED", events: [], error: null } : null
  );
  const timelineRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pending) return;
    let cancelled = false;

    async function poll() {
      try {
        const response = await fetch(`/api/conversations/${conversationId}/executions/${pending!.id}?projectId=${projectId}`, { cache: "no-store" });
        if (!response.ok) return;
        const data = await response.json() as ExecutionStateResponse;
        if (cancelled) return;
        setPending(prev => (prev ? { ...prev, status: data.status, events: data.events, error: data.error } : prev));
        if (TERMINAL_STATES.has(data.status)) {
          setPending(null);
          router.refresh();
        }
      } catch {
        // transient network error; retry on next tick
      }
    }

    void poll();
    const interval = setInterval(() => void poll(), 1500);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending?.id, conversationId, projectId]);

  useEffect(() => {
    timelineRef.current?.scrollTo?.({ top: timelineRef.current.scrollHeight });
  }, [messages.length, pending?.events.length]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = content.trim();
    if (!trimmed) {
      setComposerError("Message cannot be empty.");
      return;
    }
    setSubmitting(true);
    setComposerError("");
    try {
      const idempotencyKey = crypto.randomUUID();
      const response = await csrfFetch(`/api/conversations/${conversationId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: trimmed, provider, mode, idempotencyKey })
      });
      const data = await response.json() as { queuedExecution?: { agentSessionId: string }; error?: string };
      if (!response.ok) throw new Error(data.error ?? "Could not send message.");
      setContent("");
      setPending({ id: data.queuedExecution!.agentSessionId, status: "QUEUED", events: [], error: null });
      router.refresh();
    } catch (err) {
      setComposerError(err instanceof Error ? err.message : "Could not send message.");
    } finally {
      setSubmitting(false);
    }
  }

  const busy = submitting || pending !== null;

  return (
    <div className="grid">
      <section className="card span12">
        <h2>Provider status</h2>
        <div className="two">
          {(["codex-cli", "claude-cli"] as const).map(id => {
            const health = providerHealth[id];
            const healthy = Boolean(health?.installed && health.authentication === "AUTHENTICATED" && health.available);
            const label = !health?.installed
              ? "NOT INSTALLED"
              : health.authentication !== "AUTHENTICATED"
                ? health.authentication.replace(/_/g, " ")
                : health.available
                  ? "AVAILABLE"
                  : "UNAVAILABLE";
            return (
              <div className="row" key={id}>
                <div>
                  <h3>{providerLabel(id)}</h3>
                  <div className="mono subtle">{health?.version ?? "version unknown"}</div>
                </div>
                <span className={`pill ${healthy ? "good" : "warn"}`}>{label}</span>
              </div>
            );
          })}
        </div>
      </section>

      <section className="card span12">
        <h2>Timeline</h2>
        <div className="timeline" ref={timelineRef}>
          {messages.length === 0 && !pending && <div className="empty">No messages yet. Send the first prompt below.</div>}
          {messages.map(message => (
            <MessageBubble key={message.id} message={message} handoffCapsules={handoffCapsules} />
          ))}
          {pending && (
            <div className="msg pending card">
              <div className="row">
                <strong>Awaiting response…</strong>
                <span className="pill">{STATUS_LABELS[pending.status] ?? pending.status}</span>
              </div>
              <div className="log mono">
                {pending.events.length
                  ? pending.events
                      .filter(item => item.type === "stdout" || item.type === "stderr")
                      .map(item => item.message)
                      .join("")
                  : "Waiting for the worker to pick up this execution…"}
              </div>
              {pending.error && <p className="warn">{pending.error}</p>}
            </div>
          )}
        </div>
      </section>

      <section className="card span12">
        <h2>Send a message</h2>
        <form className="form" onSubmit={submit}>
          <label>
            Prompt
            <textarea
              value={content}
              onChange={event => setContent(event.target.value)}
              placeholder="Ask, implement, review, continue, or verify…"
              disabled={busy}
              rows={4}
            />
          </label>
          <div className="two">
            <label>
              Provider
              <select value={provider} onChange={event => setProvider(event.target.value as typeof provider)} disabled={busy}>
                <option value="auto">Auto</option>
                <option value="codex-cli">Codex</option>
                <option value="claude-cli">Claude</option>
              </select>
            </label>
            <label>
              Mode
              <select value={mode} onChange={event => setMode(event.target.value as typeof mode)} disabled={busy}>
                <option value="ASK">Ask</option>
                <option value="IMPLEMENT">Implement</option>
                <option value="REVIEW">Review</option>
                <option value="CONTINUE">Continue</option>
                <option value="VERIFY">Verify</option>
              </select>
            </label>
          </div>
          {composerError && <p className="warn">{composerError}</p>}
          <button disabled={busy}>{pending ? "Execution in progress…" : submitting ? "Sending…" : "Send"}</button>
        </form>
      </section>
    </div>
  );
}

function MessageBubble({ message, handoffCapsules }: { message: ConversationMessageView; handoffCapsules: HandoffCapsuleView[] }) {
  const isUser = message.role === "USER";
  const roleClass = isUser ? "user" : `assistant-${message.providerId ?? "unknown"}`;
  const handoff = message.handoffCapsuleId ? handoffCapsules.find(item => item.id === message.handoffCapsuleId) : undefined;

  return (
    <div className={`msg ${roleClass} card`}>
      <div className="row">
        <div className="row" style={{ gap: 8 }}>
          {isUser ? <span className="pill">USER</span> : <span className={`badge ${message.providerId ?? ""}`}>{providerLabel(message.providerId)}</span>}
          <span className="pill">{message.mode}</span>
          {message.routing && !message.routing.requestedProviderId && (
            <span className="pill">{`Auto → ${providerLabel(message.routing.selectedProviderId)}`}</span>
          )}
        </div>
        <div className="row" style={{ gap: 8 }}>
          <span className={`pill ${message.status === "FAILED" ? "warn" : message.status === "COMPLETED" ? "good" : ""}`}>{message.status}</span>
          <span className="mono subtle">{formatTimestamp(message.createdAt)}</span>
        </div>
      </div>

      {handoff && (
        <div className="handoff-note">
          Compact handoff created: {providerLabel(handoff.fromProviderId)} → {providerLabel(handoff.toProviderId)}
          <details className="debug">
            <summary>Handoff metadata</summary>
            <div className="mono subtle">
              version {handoff.version} · checksum {handoff.checksum.slice(0, 12)}… · {handoff.sizeBytes} bytes
              <br />
              source range {handoff.sourceMessageRange.fromMessageId.slice(0, 10)}… → {handoff.sourceMessageRange.toMessageId.slice(0, 10)}…
            </div>
          </details>
        </div>
      )}

      <p style={{ whiteSpace: "pre-wrap" }}>{message.content}</p>

      <details className="debug">
        <summary>Debug details</summary>
        <div className="mono subtle">
          message {message.id}
          {message.providerSessionId && <><br />provider session {message.providerSessionId}</>}
          {message.agentSessionId && <><br />execution {message.agentSessionId}</>}
          {message.taskId && <><br />task {message.taskId}</>}
        </div>
      </details>
    </div>
  );
}
