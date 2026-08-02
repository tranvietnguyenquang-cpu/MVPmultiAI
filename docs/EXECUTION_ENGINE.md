# Relay v2 execution engine

Status: **implemented and tested in Milestone 2, with runtime and streaming hardening in Milestone 2.1**. Only the in-process `FakeExecutor` is implemented. Real local CLI adapters begin in the next explicitly approved milestone.

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

The FakeExecutor descriptor is non-writing. Its `executorId` is `fake`; approved executor/model fields remain immutable metadata from the task approval.

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

## Planned

The next milestone may implement a real local executor adapter only after explicit approval. It must use this engine and cannot bypass approval, claims, events, artifacts, timeout, cancellation, or leases.
