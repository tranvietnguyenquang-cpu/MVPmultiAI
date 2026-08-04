# Relay v2 Milestone 2.2 / 2.3A / 2.3B smoke test

Status: manual checklist for FakeExecutor, the approval-bound Codex CLI boundary, and the review foundation (FakeReviewer, and the real Claude CLI reviewer). It contains no Anthropic API/MCP/deployment or automatic Git-mutation step — Claude is invoked only as a local subscription-authenticated CLI subprocess.

## Setup

1. Confirm the branch and preserve unrelated changes.
2. Point `RELAY_V2_DATA_DIR` and `RELAY_V2_DATABASE_URL` to an ignored disposable `.relay-data` directory.
3. Run `npm run db:v2:migrate`.
4. Set `RELAY_V2_ENABLED=true` and `RELAY_V2_EXECUTION_ENABLED=true`.
5. Start the local web application and open `/v2`.

## Approval authority

1. Register a disposable local Git-root project.
2. Create a manual task and confirm `PENDING_APPROVAL` has no **Request Execution** action.
3. Open Approval View and approve the exact snapshot.
4. Return to task detail and confirm the approved hash, executor, model, effort, reviewer, and permissions.
5. Edit an approved task and verify it returns to `PENDING_APPROVAL` before any execution can be requested.

## Successful FakeExecutor session

1. On an approved task select the **Success** fake scenario.
2. Choose **Request Execution**.
3. Verify the session moves through queued/claimed/preparing/running to `SUCCEEDED`.
4. Verify live output appears, sequence values are increasing, and refreshing does not lose events.
5. Verify Timeline, result summary, released workspace lease, LOG artifact, hash, and byte count.
6. Verify the registered project directory has not changed.

## SSE reconnect hardening

1. Configure a FakeExecutor session to remain nonterminal beyond one bounded SSE connection lifetime.
2. Keep the execution detail page open and verify live output resumes without refreshing the browser.
3. Verify the reconnecting notice, if shown after repeated failures, is non-blocking and clears after reconnection.
4. Verify event sequence numbers remain unique and increasing across the reconnect.
5. Verify the final terminal event appears and no further reconnect attempts occur.

## Cancellation

1. Approve a new task and select **Cancellation**.
2. Request execution and choose **Cancel Execution** while running.
3. Verify `CANCELLATION_REQUESTED`, `EXECUTION_CANCELLED`, and `WORKSPACE_RELEASED` appear.
4. Verify terminal status is `CANCELLED` and no active lease remains.
5. Repeat cancellation and verify it is harmless/idempotent.
6. Confirm a cancel request missing the project or naming a different project is rejected without changing session status.

## Runtime-host diagnostics

1. Run the automated runtime-host error-boundary test.
2. Verify an injected unexpected failure is observable with its owned session ID, has secrets redacted, and contains no stack trace.
3. Verify a later queued FakeExecutor session is still processed and the runtime stops cleanly.

## Workspace waiting

1. Queue two approved tasks for the same project while the first cancellation scenario is running.
2. Verify the second enters `WAITING_FOR_WORKSPACE`.
3. Finish or cancel the first and verify its lease releases before the second can claim.

## Failure and timeout

- Select **Failure** and verify `FAILED` is based on a validated fake result.
- Timeout is covered automatically with a short engine-owned test deadline. The UI diagnostic timeout uses the configured engine deadline and should end `TIMED_OUT` with a released lease.

## Automated verification

```powershell
npm run test:v2
npm run typecheck
npm run build
npm run test:browser:v2
```

Record exact results. Browser tests use disposable SQLite and verify approval, successful streamed FakeExecutor output, unapproved-task rejection, and cancellation. They do not start a provider or execute a project command.

## Codex diagnostics and controlled execution

1. Open `/v2/executors/codex` and choose **Test connection**.
2. Verify sanitized path, exact version, authentication status, and only locally detected capabilities appear.
3. Create a task with executor Codex, model/effort AUTO, workspace-write enabled, non-production confirmed, a timeout, and selected server-owned verification operations.
4. Approve the exact snapshot. Inspect the Git baseline before Request Execution.
5. On a clean disposable project, request Codex and verify capsule, PID, redacted live output, exact exit code, verification, final Git evidence, changed-file delta, artifacts, and released lease.
6. Verify no Commit, Push, Merge, or Deploy control exists.
7. For a dirty disposable project, verify default rejection. If dirty access was approved, acknowledge the exact displayed baseline hash and verify pre-existing changes remain distinguished.

Real smoke is opt-in only:

```powershell
$env:RELAY_V2_REAL_CODEX_SMOKE = '1'
npm run smoke:v2:codex
```

The helper creates and validates a clean committed Git repository outside Relay before Codex can start, then always removes it. It skips only for demonstrated CLI/capability/subscription-authentication unavailability; other nonzero exits fail. The Codex sandbox is read-only and no write smoke targets Relay.

Latest recorded opt-in result: **PASSED** on 2026-08-02 with Codex `0.146.0-alpha.9.2`, exact process exit code `0`, authenticated subscription CLI state, and successful disposable-workspace cleanup.

## Review gate (Milestone 2.3A/2.3B)

1. On the `SUCCEEDED` Codex execution from the previous section, open **Review Gate** and confirm it states FakeReviewer is diagnostic-only and that approval does not commit or merge.
2. Select the **Approve** scenario and choose **Request Review (diagnostic)**; verify the review reaches `APPROVED` with no blocking findings, that the execution status is still `SUCCEEDED`/`AWAITING_USER_ACCEPTANCE`, and that the status pill reads **Diagnostic approval** (not plain `APPROVED`) both on the execution page's review list and on the review detail page, with a separate `DIAGNOSTIC` authority pill and a "Commit-authority eligible: no" line alongside it.
3. Request a second review with the **Reject** scenario; verify `REJECTED` with a blocking finding is displayed.
4. Request a review with the **Needs changes** scenario; verify `NEEDS_CHANGES` with a required action is displayed.
5. Request a review with the **Invalid response (diagnostic)** scenario; verify it becomes `ERROR`, never `APPROVE`.
6. Request a review with the **Cancellation** scenario, choose **Cancel Review**, and verify it reaches `CANCELLED`.
7. Confirm no Commit, Push, Merge, Retry, or Deploy control exists anywhere on the execution or review detail pages.
8. Confirm a review request or cancellation naming a different `projectId` is rejected without changing review status.
9. Confirm the review detail page labels the reviewer's authority as `DIAGNOSTIC` and states it can never satisfy a future auto-commit or acceptance gate.
10. Edit the task's title (or objective) for a `SUCCEEDED` execution's task while a new review is `RUNNING` against it (a `delayMs` scenario gives time); confirm the review resolves to `STALE`, never `APPROVED`.

## Claude CLI reviewer (Milestone 2.3B)

1. Create and approve a task with reviewer selection **Claude** (any executor), and take it to a `SUCCEEDED` execution as above.
2. On that execution's **Review Gate**, confirm a Claude CLI diagnostics panel appears (sanitized display path, version, authentication status, last checked time) with a **Refresh diagnostics** action, and a **Request Claude Review (authoritative)** button distinct from the FakeReviewer diagnostic controls.
3. With the real local Claude CLI installed and subscription-authenticated, choose **Request Claude Review**; verify the review reaches a terminal state (`APPROVED`/`REJECTED`/`NEEDS_CHANGES`) with authority pill **AUTHORITATIVE**, structured findings/required actions rendered, reviewer version and request hash shown, a "Reviewer Invocation" card showing invocation status/CLI version/material hash/prompt hash, and no Commit/Push/Merge/Retry/Deploy control anywhere.
4. Confirm the execution status is unchanged (`SUCCEEDED`/`AWAITING_USER_ACCEPTANCE`) and "Commit-authority eligible: no" is still shown even for an AUTHORITATIVE APPROVE.
5. Repeat step 3 with Claude CLI not authenticated (or not installed) and confirm the request is rejected before any process is spawned, with a clear reason.
6. Start a Claude review and cancel it mid-run; confirm it reaches `CANCELLED` and the underlying process is terminated (no lingering process, no verdict recorded).
7. Confirm the task's approved reviewer selection is checked: a task approved for CODEX/NONE/AUTO reviewer selection never shows the Claude review button, and a direct API request for `claude-cli` against such a task is rejected.

Real Claude review smoke is opt-in only:

```powershell
$env:RELAY_V2_REAL_CLAUDE_REVIEW_SMOKE = '1'
npm run smoke:v2:claude-reviewer
```

The helper discovers the real local Claude CLI, requires current subscription authentication, builds a tiny synthetic review bundle outside the Relay repository (no Relay content, no real user project), runs exactly one real non-interactive read-only review, and requires exit code zero, valid structured JSON-Schema-conformant output, an exact `reviewedRequestHash` echo, and an unmutated disposable bundle. It skips cleanly (not a failure) when the CLI is unavailable or unauthenticated; any other failure is a genuine smoke failure. It does not require any particular APPROVE/REJECT/NEEDS_CHANGES outcome.

The strict parser (`verdict-parser.ts`) accepts the real `claude.exe` v2.1.220/v2.1.221 wrapper shape (both versions observed to share one verified contract) (`type`/`subtype`/`is_error`/`api_error_status`/`result`/`structured_output`/`permission_denials`, plus bounded telemetry) captured from a real sanitized invocation — see `docs/CLAUDE_REVIEWER.md`'s "Structured output" and "Real wrapper shape and version binding" sections. If a future CLI version's wrapper shape differs, this smoke's normal (non-diagnostic) run will fail with a parse error, exactly as designed — that is the smoke doing its job (fail-closed on an unverified wrapper), not a false negative. Re-run with `RELAY_V2_CLAUDE_SMOKE_DIAGNOSTIC=1` (see `docs/CLAUDE_REVIEWER.md`'s "Structural diagnostic mode") to capture the new shape. For a CLI version that is not in the catalog at all, use the three-gate unregistered-version diagnostic (`docs/CLAUDE_REVIEWER.md`'s "Unregistered-version structural diagnostic"), which reports `DIAGNOSTIC_ONLY` and never a verdict; register the version from that report only if the comparison shows the wrapper is identical.

Latest recorded opt-in result: **not yet run** — this milestone's implementation session runs only under Claude Code itself and is explicitly prohibited from invoking a second real Claude review turn from inside that session (see `docs/CLAUDE_REVIEWER.md`). The operator must run the command above from a separate terminal.

## Automated verification (review foundation)

```powershell
npx vitest run packages/relay-v2-reviewer/src --config vitest.v2.config.ts
npx vitest run packages/relay-v2-claude-reviewer/src --config vitest.v2.config.ts
npx vitest run packages/relay-v2-persistence/src --config vitest.v2.config.ts
```

Covers eligibility, reviewer-authority matching (approval status/reviewer-selection/task-reviewer/executor-id binding, the two narrow FakeReviewer diagnostic gates, the `CLAUDE -> claude-cli` production mapping, `NONE` rejection, reviewer-selection-changed invalidation), the immutable `ReviewInputCapsule` binding (every bound field — including live task title/objective/context, the two independent spec-integrity recomputations, and `reviewerConfigHash` for each reviewer's own authority-affecting configuration, including `claude-cli`'s locked config schema — changes `reviewInputHash`/`requestHash`, and the reviewer receives exactly the persisted `reviewInputJson`/`reviewerConfigJson`) and capsule self-referential integrity, runtime self-validation of the persisted binding (a reviewInputJson/reviewInputHash mismatch, a reviewerConfigJson/reviewerConfigHash mismatch, malformed reviewerConfigJson, and a requestHash inconsistent with either hash each become `STALE` with `failureCode: "REVIEW_IMMUTABLE_INPUT_MISMATCH"` without ever invoking the reviewer, proven against hand-seeded corrupt/legacy-style fixtures), full pre-acceptance revalidation inside the finalization transaction, cancellation/finalization CAS races, lease-bound finalization, the database-level `UNIQUE` constraint on `ReviewVerdict.reviewRequestId`, the database-enforced active-payload immutability trigger, durable claiming and lease recovery, the authority-preserving `ReviewGateProjection` and `canSatisfyAuthoritativeReviewGate` always denying regardless of authority, the review state machine and terminal immutability, FakeReviewer's six scenarios, structured-verdict invariants, append-only/duplicate-active-review persistence rules, and the migration path applying both fresh and incrementally through 2.3B. For `claude-cli` specifically (`packages/relay-v2-claude-reviewer/src`): safe executable discovery (override, PATH, and static npm-shim-text parsing — the shim is read, never executed), capability parsing from actual `--help`/`auth status --json` output, context-minimization (stdin-only material, cwd is the disposable bundle, never the argv), disposable-bundle mutation detection, prompt-injection-shaped evidence remaining inert, structured-output parsing (direct/wrapped/fenced/duplicate-object/malformed), executable-identity-drift rejection, cancellation/timeout/nonzero-exit handling, and the append-only `ReviewInvocation` forensic record.

## Expected limitations

- Real Codex is unavailable until local subscription login succeeds; the normal automated suite uses doubles only.
- No automatic commit, push, merge, checkout, reset, stash, Docker, or deployment behavior — not even for an AUTHORITATIVE Claude APPROVE.
- Expired active sessions recover to `BLOCKED`; automatic retry is intentionally not implemented. A Claude review that errors, times out, is cancelled, or goes stale is never retried automatically either — a new review request is required.
- Artifact retention cleanup is planned.
- `fake-reviewer` and `claude-cli` are the two registered reviewers; `fake-reviewer` can never produce an AUTHORITATIVE verdict, and `claude-cli` can only do so for a task approved with reviewer selection CLAUDE, and only while live diagnostics show it installed, capability-verified, and subscription-authenticated.
- A review verdict never commits, merges, or accepts an execution, regardless of authority.
