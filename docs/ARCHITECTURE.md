# ProjectRelay Architecture

## System shape

ProjectRelay is an npm-workspaces monorepo with two processes and six focused packages.

```text
Browser -> Next.js web/API -> PostgreSQL (Prisma)
                         -> Redis/BullMQ -> worker -> Codex CLI
Browser <- SSE session events <- PostgreSQL event log
worker  -> Git/commands -> registered repository
```

- `apps/web`: App Router UI and private local API routes.
- `apps/worker`: BullMQ consumer that owns provider execution and evidence capture.
- `packages/database`: Prisma schema, client, and migration.
- `packages/shared`: boundary schemas, enums, and shared types.
- `packages/providers`: provider abstraction and Codex CLI adapter.
- `packages/project-memory`: non-destructive `.ai-project` initialization and append-only update records.
- `packages/execution`: workspace containment, allowlist, redaction, process execution, and Git evidence.
- `packages/context-engine`: task capsule, checkpoint, and context-health construction.

## Trust boundaries

The browser is untrusted. API requests are parsed with Zod. Repository paths are canonicalized on the server. Commands are selected from a server-side project allowlist and spawned as executable/argument arrays with `shell: false`. The worker is not exposed over HTTP. Redis contains only job identifiers; PostgreSQL is the durable source for jobs, events, approvals, and evidence.

## Data model

Projects own allowed commands, tasks, decisions, memory updates, checkpoints, sessions, and audit events. Tasks own acceptance criteria, capsules, evidence, and sessions. A session owns an ordered event stream and usage estimates. Evidence records retain command metadata and truncated/redacted output. Task/decision/session states use database enums.

## Memory safety

Initialization creates missing memory files only. Existing files are never replaced. Generated changes are appended beneath timestamped headings and mirrored in the `MemoryUpdate` audit table with rationale, task, agent, evidence reference, timestamp, and confidence. Checkpoints are immutable files and database snapshots.

## Provider lifecycle

The UI and task model depend on `CodingProvider`, never Codex details. `CodexCliProvider` checks availability, constructs a session, passes the capsule via stdin, emits normalized events, supports abort signals, and reports estimated usage. Future providers implement the same interface.

## Session and SSE lifecycle

The API creates a `QUEUED` session and BullMQ job. The worker transitions `STARTING` then `RUNNING`, stores every normalized log/state event, and finishes in a terminal state. The SSE route polls ordered persisted events and emits heartbeats, allowing reconnects with an event cursor without binding HTTP lifetime to the worker process.

## Decision enforcement

Capsule generation includes relevant accepted decisions and all locked decisions. Before enqueueing, the server scans explicit prohibited changes and locked-decision conflict flags. A conflict blocks the task and creates an audit event; changing the decision requires a user-authored approval path.

## Known deployment boundary

This MVP binds locally and assumes trusted OS access by one user. Production hardening would add authentication, CSRF protection, encrypted credential storage, isolated containers, per-project OS permissions, and a dedicated policy service.

