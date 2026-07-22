# ProjectRelay Implementation Plan

## Phase 1 — Foundation

- Establish strict TypeScript npm workspaces, environment templates, Docker Compose, and process scripts.
- Model projects, tasks, criteria, decisions, capsules, sessions, events, evidence, checkpoints, approvals, and audit records in Prisma.
- Add the initial PostgreSQL migration.

## Phase 2 — Safe local core

- Implement workspace containment and Git inspection.
- Implement structured command allowlists, secret redaction, output truncation, timeouts, and cancellation.
- Create missing project-memory files without overwriting user content and append attributable updates.
- Implement provider-neutral contracts and the Codex CLI adapter.

## Phase 3 — Vertical slice

- Project registration UI/API.
- Task creation with criteria UI/API.
- Capsule generation and persistence.
- Session enqueue and worker execution.
- Persisted SSE log streaming.
- Git and test evidence capture.
- Evidence-backed criterion verification and checkpoint generation.

## Phase 4 — Verification and hardening

- Unit-test path containment, redaction, verification gating, and context estimates.
- Run Prisma validation/generation, lint, strict type-check, tests, and build.
- Record actual outcomes, blockers, and next action in `.ai-project` memory.

## Exit conditions

The vertical slice is code-complete when all routes and processes compile. It is environment-verified only after PostgreSQL and Redis are running, migrations apply, Codex availability is detected, and an end-to-end local session completes with evidence.

