# Relay v2 execution engine

Status: **implemented and tested through Milestone 2.2**. FakeExecutor remains the deterministic diagnostic executor; `CodexCliExecutor` is the only real local CLI executor. Claude and API providers are not implemented.

## Lifecycle

The only supported path is:

```text
Approved Task -> ExecutionEngine -> RelayExecutor -> validated ExecutionOutcome
```

`ExecutionSession` is a mutable state-machine aggregate. `ExecutionEvent` is its append-only chronological history and the source of truth for SSE. `AuditEvent` records security and authority decisions; it does not duplicate ordinary lifecycle events.

Session transitions:

```text
QUEUED -> WAITING_FOR_WORKSPACE | CLAIMED | CANCELLED | BLOCKED
WAITING_FOR_WORKSPACE -> CLAIMED | CANCELLED | BLOCKED
CLAIMED -> PREPARING | CANCELLATION_REQUESTED | FAILED | BLOCKED
PREPARING -> RUNNING | CANCELLATION_REQUESTED | FAILED | TIMED_OUT | BLOCKED
RUNNING -> CANCELLATION_REQUESTED | SUCCEEDED | FAILED | TIMED_OUT | BLOCKED
CANCELLATION_REQUESTED -> CANCELLED | TIMED_OUT | BLOCKED
SUCCEEDED | FAILED | TIMED_OUT | CANCELLED | BLOCKED -> terminal
```

Only `ExecutionEngine` changes execution lifecycle state. Invalid application-service transitions are rejected and audited.

## Approval authority

Before creating `QUEUED`, the engine checks task status, the approved approval record, specification hash, approved snapshot, executor/model/effort/reviewer, canonical permissions hash, project identity, canonical Git-root workspace, and absence of another active task execution. A stale approved value invalidates the approval and returns the task to `PENDING_APPROVAL`; the engine never manufactures replacement approval.

The FakeExecutor descriptor is non-writing. Its `executorId` is `fake`. Codex uses `codex-cli` and additionally requires approved workspace-write, non-production confirmation, timeout, verification catalog, and dirty-workspace policy. Changing any approved field invalidates authority.

## Codex execution capsule and Git evidence

Before queueing Codex, the engine captures a stable Git baseline and builds a sanitized, hashed execution capsule containing only the approved task, policy, workspace identity, Git branch/HEAD/status, timeout, and server-owned verification operations. Task prose is transported through stdin, never argv. `.env` contents, credentials, private keys, dumps, unrelated files, and conversation history are excluded.

Write-capable Codex is blocked on a dirty workspace by default. A non-critical task may proceed only when `ALLOW_DIRTY_WORKSPACE` was approved and the request acknowledges the exact stable baseline hash. Critical tasks require a clean workspace. Relay never stashes, resets, checks out, stages, commits, pushes, merges, or discards changes.

The baseline also protects existing work with content hashes, index object identity, staged/unstaged/untracked path sets, and stash-ref/list identity. Final evidence separately reports destroyed changes, hidden staging/worktree state, changed stash identity, unaccounted paths, and HEAD/branch movement. Any such signal blocks an otherwise successful Codex run. This is strong evidence-based detection, not a claim that every possible Git/filesystem concealment technique can be identified.

Post-run evidence captures branch, HEAD, status, content hashes, binary metadata, staged/unstaged/untracked state, bounded patch evidence, and a baseline-to-final delta. Pre-existing paths are marked separately from session-created changes. A branch or HEAD mutation blocks an otherwise successful run.

## Durable claims and leases

Queued sessions live in SQLite and survive process restart. Claiming uses a transaction, conditional status update, random lease token, and partial unique indexes. Only one unreleased lease may exist for a canonical workspace or session. Contenders enter `WAITING_FOR_WORKSPACE`. Heartbeats renew only the exact session/token lease.

Expired ownership is recovered only after both lease expiry and stale heartbeat checks. The session is conservatively marked `BLOCKED`, the lease is released, and execution plus security audit events are written. There is no ordinary force-unlock endpoint.

## FakeExecutor

Implemented deterministic scenarios: success, failure, timeout, cancellation, event count/delay, warnings, simulated changed-file metadata, and summary. Delay behavior is injected through execution controls, and unit tests use fast timing. FakeExecutor does not read or alter project files, use Git, launch commands, or contact a network service.

## Output and artifacts

Output is redacted before SQLite, SSE, or artifact persistence. SQLite stores bounded previews. Full bounded NDJSON logs and simulated changed-file JSON live below:

```text
<Relay data>/artifacts/executions/<session-id>/
```

Artifact rows contain relative path, SHA-256, byte count, and truncation status. Artifacts are app-owned and outside project workspaces. Milestone 2 performs no automatic artifact deletion.

## SSE

`GET /api/v2/executions/{id}/events` checks loopback access and project/session ownership. It reads persisted events by monotonic sequence, prefers reconnect `Last-Event-ID` over the initial `cursor`, avoids duplicates, polls bounded batches, and closes after terminal events are drained. The bounded server connection lifetime and polling interval are configurable for tests.

The browser keeps one native `EventSource` open and permits its automatic reconnect after a nonterminal bounded close or temporary network error. A stable sequence cursor deduplicates rendered events. Repeated failures show a non-blocking reconnecting message; terminal completion and component unmount close the source. A disconnect loses no event because persisted `ExecutionEvent` rows, not memory, are the source of truth.

## Runtime-host diagnostics

Every scheduled runtime tick has a top-level error boundary. Unexpected claim, recovery, or owned-session errors produce a bounded, secret-redacted structured diagnostic with a session ID when ownership is known. Diagnostics omit stack traces, retain only the latest 50 entries in process memory, are exposed through runtime status and an optional callback, and cannot stop the polling loop. Session lifecycle remains owned by `ExecutionEngine`; uncertain abandoned ownership is handled by durable stale recovery.

## Implemented UI

- `/v2/executions`: sessions, runtime/FakeExecutor health, and lease history.
- `/v2/executions/{id}`: live events, timeline, approved metadata, lease state, result, artifacts, and cancellation.
- Approved task detail: explicit FakeExecutor scenario and separate **Request Execution** action.

Execution cancellation requires the owning `projectId` and returns the same not-found response for absent and wrong-project sessions before invoking the engine.

## Local process and verification boundary

Only `SafeProcessRunner` imports `node:child_process`. It validates absolute executable and working-directory paths, uses argv arrays and `shell: false`, passes an allowlisted environment, records exact PID/start identity, streams redacted output, bounds artifacts, and owns cancellation/timeout. On Windows, process-tree termination targets only the owned PID with argument-array `taskkill.exe`.

Abort observation begins before asynchronous validation and is rechecked before and immediately after spawn. After ownership exists, cancellation/timeout converges on one termination promise. The executor stream cannot finish normally until actual child exit, so `ExecutionEngine` cannot finalize or release the lease while the process remains owned.

The server-owned verification catalog currently supports `npm test`, `npm run typecheck`, and `npm run build` through Node plus npm's CLI entry point—never an arbitrary task-supplied shell string. Exit zero without passing the approved verification list is `FAILED`, not accepted success.

## Review gate (Milestone 2.3A)

A `SUCCEEDED` session with its task at `AWAITING_USER_ACCEPTANCE` may request an evidence-bound review through `ReviewEngine` (see `docs/REVIEW_ENGINE.md`). A review verdict never changes `ExecutionSession` or `Task` status — it only sets a separately computed, authority-preserving `ReviewGateProjection` (never a plain status string; `commitAuthorityEligible` is always `false` in this milestone). `AWAITING_USER_ACCEPTANCE` still means what it always meant: the execution result requires later user acceptance.

Requesting a review never runs a reviewer inline: the API only creates a `PENDING` `ReviewRequest` row, and a separate `ReviewRuntimeHost` durably claims and runs it (mirroring this engine's own `ExecutionRuntimeHost` claim/lease/heartbeat/recovery design). Reviewer authority is matched against the task's approved reviewer selection independently of executor selection — see "Reviewer authority" in `docs/REVIEW_ENGINE.md`.

## Planned

Real Claude CLI review (Milestone 2.3B) and an auto-commit gate that can act on an approved review (Milestone 2.4) remain later, separately approved milestones. Automatic commit, merge, push, deployment, MCP, and API providers remain planned.
