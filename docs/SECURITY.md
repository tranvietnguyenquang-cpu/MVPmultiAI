# Relay v2 security boundaries

Status: Milestone 1 local task/import/approval boundaries are implemented and tested. Runtime command policy, executor sandboxing, provider transmission approval, secure API credentials, and MCP authentication are planned for their later milestones.

## Local and feature isolation

- `/v2` and `/api/v2` are isolated behind `RELAY_V2_ENABLED`.
- Mutating v2 routes independently require loopback request headers, same-origin requests, and a matching CSRF cookie/header token.
- The v2 browser client obtains only a CSRF token. It does not bootstrap the legacy PostgreSQL-backed local session.
- v2 production source has no imports or call paths to BullMQ, Redis, workers, provider packages, child processes, session queues, or legacy execution APIs.
- Approval responses explicitly return `executionQueued: false`.
- There is no v2 run, work-item, agent-session, or execution-run model in the Milestone 1 database.

These controls preserve the legacy runtime without making it reachable from a v2 task action. Milestone 2 must introduce a separately reviewed execution boundary rather than connecting this milestone to the legacy queue.

## Persistence

The v2 SQLite database is separate from PostgreSQL. Milestone 1 writes only v2 projects, tasks, approvals, audit events, and preview reports to SQLite. The optional legacy report reads selected legacy rows and cannot write to PostgreSQL. It treats all legacy approvals as skipped evidence, never as v2 authorization. Ambiguous active state mappings are excluded with a reason.

Audit events are append-only at both the service contract and SQLite-trigger level. Details are bounded structured JSON and exclude task bodies, environment files, credentials, and raw internal exceptions.

## Approval authority

Every task begins in `PENDING_APPROVAL`. Approval records the exact specification hash, executor, model, effort, reviewer, permissions, approver, and resolution time. Approval changes status only to `APPROVED`. It has no execution side effect.

The orchestrator and explicit transition map are the only supported v2 status-change path. Milestone 1 exposes only draft submission, approval, cancellation/rejection, and approval invalidation after an edit. Invalid transitions are rejected and audited.

## Input and secret handling

- All API request bodies and normalized handoffs are strict Zod schemas.
- YAML custom tags, aliases, duplicate keys, and merge keys are not accepted.
- Handoffs are size limited before parsing.
- Likely secrets are rejected before task persistence.
- Environment-file contents are never read or logged by the handoff workflow.
- Browser-facing unexpected errors use a fixed message; absolute paths and connection strings are redacted from deliberate errors as a backstop.

Milestone 1 stores no API keys. Optional provider credentials and OS secure storage remain planned for Milestone 5.

## Legacy report

The legacy report is preview-only. It reports selected source counts, candidate counts, skipped counts, and reasons. It creates an `ImportReport` and audit event in SQLite. It does not copy source rows, change PostgreSQL, infer approval, or enable execution.

## Planned boundaries

Milestone 2 must add command risk classification, dedicated dangerous approval, process cancellation/timeout, secret redaction for streaming output, workspace locking, and Git evidence before any executor is connected. MCP and provider APIs remain out of scope until their explicit milestones.

