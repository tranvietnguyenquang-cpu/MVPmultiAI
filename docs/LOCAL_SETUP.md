# Relay v2 local setup

Status: Milestone 1 implemented. Agent execution, provider APIs, MCP, and remote access are planned for later milestones.

## Prerequisites

- Windows 10 or later
- Node.js and npm versions supported by the existing Relay repository
- A local Git repository to register as a project

Milestone 1 does not require Codex CLI, Claude Code, Redis, BullMQ workers, or a running PostgreSQL server for the `/v2` workflow. The legacy application still retains its existing prerequisites and behavior.

## Install and initialize

```powershell
npm install
npm run db:v2:generate
$env:RELAY_V2_DATABASE_URL = 'file:C:/path/to/disposable/relay-v2.db'
npm run db:v2:migrate
```

For normal local use, Relay resolves its v2 data directory to `%LOCALAPPDATA%\Relay`. If `RELAY_V2_DATA_DIR` is explicitly set, that absolute directory is used instead. In development, when `NODE_ENV` is not `production`, the default is the ignored repository directory `.relay-data`. Automated tests must set an explicit disposable data directory and `PROJECT_RELAY_TEST_MODE=true`; the path resolver fails closed otherwise.

The database URL is derived as `file:<data-directory>/relay-v2.db`. `RELAY_V2_DATABASE_URL` may be supplied directly for Prisma migration commands. API keys are never stored in this database.

Enable or disable the isolated UI with:

```powershell
$env:RELAY_V2_ENABLED = 'true'   # enabled by default
$env:RELAY_V2_ENABLED = 'false'  # /v2 and /api/v2 return not found
```

Start the existing web development server normally and open `http://localhost:3300/v2`. The v2 navigation is side-by-side with the legacy application.

## SQLite behavior verified in Milestone 1

Tested on Windows with Prisma 6.19.3 and SQLite:

- checked-in migrations deploy to a new database;
- foreign keys are enabled per connection;
- transactions roll back atomically;
- unique indexes reject sequential and concurrent duplicate writes;
- `DateTime` values round-trip as JavaScript `Date` objects;
- enum-like fields use normalized strings plus migration-level `CHECK` constraints;
- structured values use canonical JSON in `TEXT` columns plus `json_valid` constraints;
- WAL mode is enabled;
- a 5000 ms busy timeout is configured for every Relay-created client;
- audit-event update and delete operations are rejected by SQLite triggers.

Connector limitations:

- Prisma's SQLite connector does not provide the PostgreSQL enum and JSON column semantics used by the legacy schema. Relay validates values with Zod and reinforces them with SQLite checks.
- WAL improves reader/writer coexistence but SQLite still serializes writes. Milestone 1 assumes a single local Relay application with short transactions; it is not a distributed multi-writer design.
- `foreign_keys` and `busy_timeout` are connection settings, so Relay initializes them whenever it creates a client.
- The generated Prisma client is schema-specific and lives under the ignored `packages/relay-v2-persistence/generated` directory.

## Verification commands

```powershell
npm run test:v2
npm run typecheck
npm run lint
npm run build
npm run test:browser:v2
```

`test:v2` and `test:browser:v2` use disposable SQLite data and do not start the legacy PostgreSQL/Redis integration stack. See `docs/SMOKE_TEST.md` for the manual checklist.

## Known Milestone 1 limitations

- Approval ends at `APPROVED`; it cannot queue or execute a process.
- Legacy migration is preview/report-only. It never imports legacy approvals as v2 authorization.
- The SQLite database has no backup UI yet. Before deleting a development database, verify the exact `.relay-data` path.
- Portable mode is not implemented.

