# Relay v2 troubleshooting

## Codex is not found

Open `/v2/executors/codex` and run Test connection. Relay checks an explicit `RELAY_V2_CODEX_PATH`, `PATH`, and the app-bundled installation below `%LOCALAPPDATA%\OpenAI\Codex\bin`. The path must resolve to a real file. Relay does not automate the desktop app.

## Codex is installed but unavailable

Run `codex login status` in your normal user terminal. Relay relies on subscription CLI authentication and does not use or store an OpenAI API key. Login status is a time-stamped diagnostic and can change after persistence; Relay refreshes it before execution authority and process start. An authenticated diagnostic still does not prove that any task executed.

## Model or effort is blocked

Use AUTO. Relay omits model and reasoning overrides unless a supported local catalog/mapping has been verified. The existence of `--model` alone does not prove a particular marketing model name is valid.

## Dirty workspace is blocked

Codex writes are clean-workspace by default. Inspect the Git baseline. Non-critical work may proceed only when dirty-workspace permission was part of the approved snapshot and the request acknowledges the exact stable evidence hash. Critical work always requires clean state. Relay never cleans, stashes, or resets for you.

## Execution is BLOCKED after restart

Relay will not attach to a process based on PID alone. If PID/start ownership cannot be proven after runtime loss, stale recovery conservatively blocks the session and releases its expired lease. Review partial logs and Git evidence before creating a newly approved task.

## Exit zero did not succeed

Exit zero is only one input. A run fails or blocks if approved verification fails, final Git evidence cannot be captured, HEAD/branch or stash identity changes, or protected pre-existing staged/unstaged/untracked work disappears or becomes hidden. Model prose never overrides these checks.

## Output was truncated

SQLite previews and artifact logs are bounded. Artifact metadata shows byte count, hash, and truncation. All retained output is secret-redacted.
