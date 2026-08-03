# Relay v2 security boundaries

Status: Milestones 2 through 2.2 are implemented and tested, including the approval-bound Codex CLI process boundary. No Claude/API/MCP/deployment integration is present.

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

## Codex process boundary

- API routes create durable requests or read diagnostics; they never import `child_process` or launch Codex directly.
- Only `packages/relay-v2-execution/src/process-runner.ts` imports `node:child_process`.
- Executables and workspaces are canonical absolute paths; argv is an array; `shell` is always false.
- Task content is stdin, not a command argument. Model/effort flags are emitted only for verified supported selections.
- Environment inheritance is limited to OS execution, PATH, user-profile authentication, temp, terminal/locale, and approved Codex configuration. Secret-like keys are denied and environment values are never logged.
- Output is redacted before events, SSE, diagnostics, or artifacts.
- Windows cancellation targets the exact owned PID tree; Relay never kills by process name or reattaches from PID alone.
- Pre-spawn cancellation is checked before/through validation and around spawn. A termination failure retains process ownership and the workspace lease until exit rather than reporting a false completed cancellation.
- Codex diagnostics responses use an explicit DTO. Raw executable paths remain server-side; browser/API responses expose only sanitized `displayPath` values.
- Dirty-baseline evidence protects staged, unstaged, untracked, index, stash, HEAD, and branch identity. Suspected loss or concealment of pre-existing work blocks success.

## Dependency isolation

Automated transitive graph tests cover the v2 packages, API routes, libraries, app routes, and Relay v2 UI components. They ensure these sources cannot reach legacy execution, provider SDKs, workers, Redis, BullMQ, cross-spawn, MCP, or external API endpoints. They prove `node:child_process` is reachable only from SafeProcessRunner and not UI/API sources. Display labels are not treated as integrations.

Runtime-host operational diagnostics contain only bounded, redacted error messages; stack traces are not retained. Callback failures cannot break polling. A known owned session is identified for diagnostics, while engine cleanup or conservative stale recovery owns its durable lifecycle.

FakeExecutor:

- runs entirely in-process;
- has `writeCapability=false`;
- makes no external API call;
- starts no process or shell;
- performs no Git, Docker, or project filesystem mutation.

Legacy execution remains present and recoverable but was not changed by Milestone 2.

## Planned

Claude review, broader operation-risk catalogs, dedicated dangerous-operation approvals, secure API credentials, and MCP remain later work. Automatic Git mutation and deployment are not present.
