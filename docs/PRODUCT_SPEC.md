# ProjectRelay Product Specification

## Product statement

ProjectRelay is a local-first control plane for continuing AI-assisted coding work from verified repository state instead of long chat history. A single local user registers a Git repository, describes a task and its acceptance criteria, generates a compact task capsule, runs a controlled coding-provider session, attaches command and Git evidence, and rolls the resulting state into a checkpoint.

## MVP user journey

1. Register an existing local Git repository and a command allowlist.
2. Inspect its branch, working-tree status, and recent commits.
3. Create a task with constraints and independently verifiable acceptance criteria.
4. Generate and persist a minimal capsule from repository memory and relevant decisions.
5. Start a Codex CLI session in the configured workspace through a queued worker job.
6. Follow redacted stdout/stderr through Server-Sent Events and cancel when necessary.
7. Capture Git state and allowlisted test/build results as evidence.
8. Review each criterion and attach evidence before marking the task verified.
9. Create a checkpoint that is sufficient to begin a fresh provider session.

## Functional boundaries

The MVP is single-user and local. It supports projects, structured memory, decisions, tasks, capsules, Codex sessions, evidence, checkpoints, execution approvals, and audit events. Provider and execution contracts are reusable. Team collaboration, billing, pull-request automation, concurrent branch writers, Claude execution, vector search, Kubernetes, and mobile clients are excluded.

## Source-of-truth order

1. Current repository and Git evidence.
2. Accepted and locked decisions.
3. Structured `.ai-project` memory.
4. Task acceptance state and captured command evidence.
5. Provider-generated summaries.

Conflicts are displayed and reduce context confidence. Provider prose never overrides repository or command evidence.

## Verification rules

A task may be `VERIFIED` only when every acceptance criterion has at least one successful evidence record. A successful provider run is not verification. Locked accepted decisions cannot be edited by an agent; conflicts create a decision-change proposal and block execution.

## Security requirements

Repository paths and candidate targets are realpath-canonicalized and must remain inside an absolute Git workspace, including across Windows junctions. Browser input selects server-owned command IDs, never executables, arguments, or shell text. Mutating routes require same-origin double-submit CSRF validation. Commands use a Windows-aware array launcher, a minimal environment, timeouts, cross-process cancellation, output limits, and stream-safe secret redaction. Destructive command categories require a durable approval record. Provider credentials remain owned by local CLIs and are never stored by ProjectRelay.

## MVP success criteria

- The full journey can be executed locally with PostgreSQL, Redis, the web process, worker process, and an installed Codex CLI.
- Capsules and checkpoints are persisted and contain no conversation transcript.
- Session logs stream while running and contain no obvious secrets.
- Git and command evidence can be traced to a task and acceptance criterion.
- Lint, strict type-check, unit tests, and production build pass in a clean setup.
