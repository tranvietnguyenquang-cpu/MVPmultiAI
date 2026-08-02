# Relay v2 local setup

Status: Milestones 1 and 2 implemented. The provider-neutral engine and FakeExecutor are tested; real AI providers, command execution, MCP, and remote access are not implemented.

## Prerequisites

- Windows 10 or later
- Node.js and npm supported by this repository
- A local Git repository to register

The v2 workflow does not require a running PostgreSQL server, Redis, BullMQ worker, real AI CLI, or API credential. Legacy application prerequisites remain unchanged.

## Initialize

```powershell
npm install
npm run db:v2:generate
$env:RELAY_V2_DATA_DIR = 'C:\path\to\Relay-data'
$env:RELAY_V2_DATABASE_URL = 'file:C:/path/to/Relay-data/relay-v2.db'
npm run db:v2:migrate
```

Normal production-local data defaults to `%LOCALAPPDATA%\Relay`. Development defaults to ignored `.relay-data`. Tests require an explicit disposable data directory and fail closed otherwise.

Feature switches:

```powershell
$env:RELAY_V2_ENABLED = 'true'
$env:RELAY_V2_EXECUTION_ENABLED = 'true'
```

Set `RELAY_V2_EXECUTION_ENABLED=false` to disable execution routes and UI while retaining Milestone 1 task handling.

Start the existing web application and open `/v2`. The in-process v2 runtime starts its bounded SQLite polling loop when an execution screen or request initializes it. It is separate from the legacy worker and imports no legacy queue or provider package.

## SQLite behavior

SQLite uses foreign keys, WAL, a 5000 ms busy timeout, short claim transactions, JSON checks, enum-like `CHECK` constraints, partial unique active-session/lease indexes, and append-only triggers for audit and execution events. SQLite still serializes writes; Relay v2 is a local single-user runtime, not a distributed worker cluster.

Artifacts are stored below `<data-directory>\artifacts\executions`. They are bounded and redacted. No retention cleanup UI exists yet.

## Verification

```powershell
npm run test:v2
npm run typecheck
npx eslint packages/local-safety/src packages/relay-v2-domain/src packages/relay-v2-persistence/src packages/relay-v2-orchestrator/src packages/relay-v2-execution/src apps/web/app/v2 apps/web/app/api/v2 apps/web/components/relay-v2 apps/web/lib/relay-v2 e2e-v2 --max-warnings=0
npm run build
npm run test:browser:v2
```

See `docs/SMOKE_TEST.md`. Real CLI smoke tests are not part of Milestone 2.

## Limitations

- Only FakeExecutor is registered.
- Fake scenario configuration is an explicit Milestone 2 diagnostic facility and is not a provider model selection.
- Runtime hosting is in the local Next server process; durable queued sessions survive restart, while an expired active owner is recovered conservatively to `BLOCKED`.
- Legacy migration remains report-only.
- Portable mode and automated artifact retention are not implemented.
