# Relay v2 local setup

Status: Milestones 1 through 2.3B implemented. FakeExecutor and the local Codex CLI boundary are tested with doubles. The review foundation is tested with FakeReviewer and, for the real Claude CLI reviewer, with process doubles plus an opt-in real smoke (`docs/CLAUDE_REVIEWER.md`, `docs/SMOKE_TEST.md`). Provider APIs, MCP, and remote access are not implemented — Claude is invoked only as a local subscription-authenticated CLI subprocess.

## Prerequisites

- Windows 10 or later
- Node.js and npm supported by this repository
- A local Git repository to register

FakeExecutor does not require PostgreSQL, Redis, BullMQ, a CLI, or API credentials. Codex execution requires a supported local Codex CLI subscription login. Legacy application prerequisites remain unchanged.

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

Start the existing web application and open `/v2`. The v2 runtime starts its bounded SQLite polling loop when an execution screen or request initializes it. It is separate from the legacy worker and imports no legacy queue or provider package. Open `/v2/executors/codex` to persist a sanitized capability snapshot.

Optional executable override:

```powershell
$env:RELAY_V2_CODEX_PATH = 'C:\absolute\path\to\codex.exe'
```

Relay otherwise checks `PATH` and the local Codex app installation below `%LOCALAPPDATA%`. Normal `USERPROFILE`/`HOME` access is inherited for subscription authentication, but credential files are never read or logged by Relay.

Claude CLI executable override:

```powershell
$env:RELAY_V2_CLAUDE_PATH = 'C:\absolute\path\to\claude.exe'
```

Without an override, Relay checks `PATH` for `claude.exe` directly, and (Windows only) statically parses — never executes — an npm-generated `claude.cmd`/`claude.ps1` shim on `PATH` to recover the real native binary it points at. Open `/v2/executors/codex`'s reviewer counterpart, the Claude diagnostics panel shown on an execution page approved for the Claude reviewer, to persist a sanitized capability snapshot. Normal `USERPROFILE`/`APPDATA`/`LOCALAPPDATA` access is inherited for the Claude subscription (claude.ai) login; `ANTHROPIC_API_KEY` and every other provider-shaped credential environment variable are stripped before the process is ever spawned (`SafeProcessRunner`'s environment allowlist), and Relay never reads or logs a credential file. See `docs/CLAUDE_REVIEWER.md` for the full discovery/isolation/invocation model.

## SQLite behavior

SQLite uses foreign keys, WAL, a 5000 ms busy timeout, short claim transactions, JSON checks, enum-like `CHECK` constraints, partial unique active-session/lease indexes, and append-only triggers for audit and execution events. SQLite still serializes writes; Relay v2 is a local single-user runtime, not a distributed worker cluster.

Artifacts are stored below `<data-directory>\artifacts\executions`. They are bounded and redacted. No retention cleanup UI exists yet.

## Verification

```powershell
npm run test:v2
npm run typecheck
npx eslint packages/local-safety/src packages/relay-v2-domain/src packages/relay-v2-persistence/src packages/relay-v2-orchestrator/src packages/relay-v2-execution/src packages/relay-v2-reviewer/src packages/relay-v2-claude-reviewer/src apps/web/app/v2 apps/web/app/api/v2 apps/web/components/relay-v2 apps/web/lib/relay-v2 e2e-v2 --max-warnings=0
npm run build
npm run test:browser:v2
```

See `docs/SMOKE_TEST.md`. Real Codex smoke is opt-in by setting `RELAY_V2_REAL_CODEX_SMOKE=1` before `npm run smoke:v2:codex`; it uses a disposable read-only workspace. Real Claude reviewer smoke is opt-in the same way: `RELAY_V2_REAL_CLAUDE_REVIEW_SMOKE=1` before `npm run smoke:v2:claude-reviewer`.

## Limitations

- FakeExecutor and Codex CLI are registered; Codex remains unavailable until diagnostics verify installation, capabilities, and login.
- `fake-reviewer` and `claude-cli` are the two registered reviewers. `claude-cli` can only ever produce an AUTHORITATIVE verdict for a task whose approved reviewer selection is CLAUDE, and only when live diagnostics show it installed, capability-verified, and authenticated with a subscription session at the moment of review. Reviewing a FakeExecutor session with `fake-reviewer` requires an explicit diagnostic flag and is never enabled outside automated tests.
- A review verdict — DIAGNOSTIC or AUTHORITATIVE — does not commit, merge, or accept an execution; the auto-commit gate is a later, separately approved milestone.
- Explicit Codex model/effort values remain blocked without a verified local catalog; AUTO omits overrides.
- Runtime hosting is in the local Next server process; durable queued sessions survive restart, while an expired active owner is recovered conservatively to `BLOCKED`.
- Legacy migration remains report-only.
- Portable mode and automated artifact retention are not implemented.
