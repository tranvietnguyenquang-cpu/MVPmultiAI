# Relay v2 security boundaries

Status: Milestone 2 approval authority, SQLite execution claims, exclusive leases, redacted artifacts, SSE ownership, cancellation, timeout, and FakeExecutor isolation are implemented and tested. Milestone 2.1 hardens streaming, cancellation scoping, isolation coverage, and runtime diagnostics.

## Local boundary

- `/v2` and `/api/v2` remain feature-isolated.
- Mutations require loopback headers, same-origin classification, and matching CSRF cookie/header.
- Execution SSE additionally checks project/session ownership and reads only redacted persisted events.
- Execution cancellation requires `projectId`, verifies project/session ownership before cancellation, and does not reveal cross-project session existence.
- The v2 browser does not bootstrap the legacy PostgreSQL session.

## Execution authority

Only `ExecutionEngine.requestExecution` creates a session. It rechecks the task and exact approved snapshot server-side. Changed spec hash, executor, model, effort, reviewer, or permissions invalidates approval and returns the task to `PENDING_APPROVAL`. Approval does not queue work by itself.

Only the engine changes `ExecutionSession` status. FakeExecutor returns typed events and a validated result; prose cannot mark success. Terminal sessions are immutable.

## Workspace ownership

Project paths are revalidated as canonical Git roots before request and claim. A partial unique SQLite index permits one active workspace writer. Lease renewal requires the random token. Stale recovery requires expired ownership and stale heartbeat evidence, blocks the uncertain session, releases its lease, and audits the recovery. There is no normal force unlock.

## Output

The dependency-free local-safety package redacts output before database previews, SSE, or artifacts. Environment files and credentials are not read. Artifact paths are generated below app-owned storage, never inside project source. Fake changed-file entries are simulated metadata.

## Dependency isolation

Automated transitive graph tests cover the v2 packages, API routes, libraries, app routes, and Relay v2 UI components. They ensure these sources cannot reach legacy execution, provider adapters or SDKs, workers, Redis, BullMQ, cross-spawn, `node:child_process`, shell calls, MCP runtime code, external provider endpoints, or Git/Docker mutation paths. Display-only executor labels such as `CODEX` and `CLAUDE` are permitted and are not treated as integrations.

Runtime-host operational diagnostics contain only bounded, redacted error messages; stack traces are not retained. Callback failures cannot break polling. A known owned session is identified for diagnostics, while engine cleanup or conservative stale recovery owns its durable lifecycle.

FakeExecutor:

- runs entirely in-process;
- has `writeCapability=false`;
- makes no external API call;
- starts no process or shell;
- performs no Git, Docker, or project filesystem mutation.

Legacy execution remains present and recoverable but was not changed by Milestone 2.

## Planned

Real local CLI execution, command risk classification, Git evidence, and dedicated dangerous-operation approvals begin only in a later explicitly approved milestone. Provider APIs, secure credentials, and MCP remain later work.
