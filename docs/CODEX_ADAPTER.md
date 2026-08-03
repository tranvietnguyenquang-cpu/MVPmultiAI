# Relay v2 Codex CLI adapter

Status: **implemented and tested with captured help fixtures, process doubles, disposable-Git safety tests, and an opt-in real read-only smoke in Milestone 2.2**. The real smoke passed with Codex `0.146.0-alpha.9.2` on 2026-08-02; local login state remains time-varying and must still be refreshed.

## Verified local capability snapshot

Audit date: 2026-08-02. The app-bundled executable was discovered below `%LOCALAPPDATA%\OpenAI\Codex\bin`; it was not on `PATH`.

- Version: `codex-cli 0.146.0-alpha.9.2`
- Non-interactive command: `codex exec`
- Prompt transport: stdin using `-`
- Model option: `--model` exists, but no local supported model catalog was discovered; `AUTO` therefore omits it
- Reasoning effort: no verified direct option or catalog; `AUTO` uses the local Codex default
- Working directory: `-C` / `--cd`
- Sandbox: `workspace-write` and `read-only` were present in help
- Approval policy: root `-a never` was verified with `exec --help`
- Output: JSONL `--json`, output schema, and last-message options were present
- Authentication: `codex login status` returned `Not logged in` with exit code 1

Unknown or unsupported capabilities stay unknown. Relay does not invent model names, effort mappings, flags, or authentication state.

## Safe invocation

`CodexCliExecutor` is available only through `ExecutionEngine`. It builds an executable plus argv array, sends task prose only through stdin, sets `shell: false`, selects an explicit canonical workspace, and passes an allowlisted environment. API and UI code cannot import the process runner.

The default argv uses ephemeral, ignore-user-config, no-color, JSONL, `workspace-write`, no interactive approval, and an explicit working directory. An explicit model or effort is blocked unless a verified local catalog/mapping was injected. `AUTO` omits both overrides.

Subscription authentication may use normal `USERPROFILE`/`HOME` access. Relay does not read or log Codex credential files. It does not use the OpenAI API. `codex login status` is time-stamped diagnostic evidence, not proof that a task ran; capability/authentication checks refresh before an execution request and again before process start.

## Process ownership and result truth

Relay records PID, a Relay process identity, and start time. Cancellation targets only that owned execution. Windows termination invokes `taskkill.exe` with `['/PID', pid, '/T', '/F']`, `shell: false`; no process-name kill is used. Cancellation is observed before validation, before spawn, immediately after spawn, and while running. Ownership and the workspace lease remain held until actual process exit; a failed terminator is reported redacted and does not make the workspace available.

Exit zero is necessary but not sufficient for success. Relay-owned verification must pass, and final Git evidence must be captured. Model prose has no authority over status.

## Limitations

- Login status can be `AUTHENTICATED`, `UNAUTHENTICATED`, or `UNKNOWN`; it remains separate from real-execution readiness and is never treated as execution success.
- Explicit model and reasoning-effort selection remain unsupported without a verified local catalog.
- Structured Codex JSONL is streamed as redacted output; lifecycle truth comes from the process and engine, not model events.
- No automatic commit, push, merge, review, deployment, or production operation exists.
- Claude integration begins only after this milestone is independently approved.

## Opt-in real smoke

`npm run smoke:v2:codex` skips unless `RELAY_V2_REAL_CODEX_SMOKE=1`. When enabled, it creates a temporary directory outside Relay, initializes a Git repository, configures repository-local disposable identity, commits a clean `README.md` baseline, verifies root/HEAD/status, and only then invokes Codex with the read-only sandbox. It checks the exact exit code and always removes the repository. Authentication-related output is classified as skipped only when it demonstrates unavailable subscription login; other nonzero exits fail the smoke.
