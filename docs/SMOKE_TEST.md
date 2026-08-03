# Relay v2 Milestone 2.2 / 2.3A smoke test

Status: manual checklist for FakeExecutor, the approval-bound Codex CLI boundary, and the FakeReviewer-only review foundation. It contains no Claude/API/MCP/deployment or automatic Git-mutation step.

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

## Review gate (Milestone 2.3A)

1. On the `SUCCEEDED` Codex execution from the previous section, open **Review Gate** and confirm it states FakeReviewer is diagnostic-only and that approval does not commit or merge.
2. Select the **Approve** scenario and choose **Request Review**; verify the review reaches `APPROVED` with no blocking findings, that the execution status is still `SUCCEEDED`/`AWAITING_USER_ACCEPTANCE`, and that the status pill reads **Diagnostic approval** (not plain `APPROVED`) both on the execution page's review list and on the review detail page, with a separate `DIAGNOSTIC` authority pill and a "Commit-authority eligible: no" line alongside it.
3. Request a second review with the **Reject** scenario; verify `REJECTED` with a blocking finding is displayed.
4. Request a review with the **Needs changes** scenario; verify `NEEDS_CHANGES` with a required action is displayed.
5. Request a review with the **Invalid response (diagnostic)** scenario; verify it becomes `ERROR`, never `APPROVE`.
6. Request a review with the **Cancellation** scenario, choose **Cancel Review**, and verify it reaches `CANCELLED`.
7. Confirm no Commit, Push, Merge, Retry, or Deploy control exists anywhere on the execution or review detail pages.
8. Confirm a review request or cancellation naming a different `projectId` is rejected without changing review status.
9. Confirm the review detail page labels the reviewer's authority as `DIAGNOSTIC` and states it can never satisfy a future auto-commit or acceptance gate.
10. Edit the task's title (or objective) for a `SUCCEEDED` execution's task while a new review is `RUNNING` against it (a `delayMs` scenario gives time); confirm the review resolves to `STALE`, never `APPROVED`.

## Automated verification (review foundation)

```powershell
npx vitest run packages/relay-v2-reviewer/src --config vitest.v2.config.ts
npx vitest run packages/relay-v2-persistence/src --config vitest.v2.config.ts
```

Covers eligibility, reviewer-authority matching (approval status/reviewer-selection/task-reviewer/executor-id binding, the two narrow diagnostic gates, `NONE` rejection, reviewer-selection-changed invalidation), the immutable `ReviewInputCapsule` binding (every bound field — including live task title/objective/context, the two independent spec-integrity recomputations, and `reviewerConfigHash` for the reviewer's own authority-affecting configuration — changes `reviewInputHash`/`requestHash`, and the reviewer receives exactly the persisted `reviewInputJson`/`reviewerConfigJson`) and capsule self-referential integrity, runtime self-validation of the persisted binding (a reviewInputJson/reviewInputHash mismatch, a reviewerConfigJson/reviewerConfigHash mismatch, malformed reviewerConfigJson, and a requestHash inconsistent with either hash each become `STALE` with `failureCode: "REVIEW_IMMUTABLE_INPUT_MISMATCH"` without ever invoking the reviewer, proven against hand-seeded corrupt/legacy-style fixtures), full pre-acceptance revalidation inside the finalization transaction (binding re-verified first, then evidence/approval/task/execution/authority/title/objective/summary rechecked fresh, reported as `EVIDENCE_CHANGED` when that layer is what drifted), cancellation/finalization CAS races (cancel-wins, verdict-wins, invalid-output-racing-cancellation, idempotent repeated cancellation), lease-bound finalization (expired lease, superseded ownership generation, mismatched owner/lease-token/claim-attempt each independently block finalization, stale recovery winning the race, ownership fields cleared only by the winning transaction), the database-level `UNIQUE` constraint on `ReviewVerdict.reviewRequestId` (including a genuine race for the first verdict slot on a zero-verdict request, repeated to reduce flakiness), the database-enforced active-payload immutability trigger (protected fields rejected while `PENDING`/`CLAIMED`/`RUNNING`/`CANCELLATION_REQUESTED`, legitimate lifecycle fields still mutable in each), durable claiming and lease recovery (atomic cross-instance claim, heartbeat, restart-safe `PENDING`, stale-lease recovery to `STALE`/`CANCELLED`, two runtime hosts never double-owning a review), the authority-preserving `ReviewGateProjection` and `canSatisfyAuthoritativeReviewGate` always denying in this milestone, the review state machine and terminal immutability, FakeReviewer's six scenarios, structured-verdict invariants, append-only/duplicate-active-review persistence rules, and the Milestone 2.3A migration applying both fresh and incrementally on top of an Alpha 0.3 database.

## Expected limitations

- Real Codex is unavailable until local subscription login succeeds; the normal automated suite uses doubles only.
- No automatic commit, push, merge, checkout, reset, stash, Docker, or deployment behavior.
- Expired active sessions recover to `BLOCKED`; automatic retry is intentionally not implemented.
- Artifact retention cleanup is planned.
- `fake-reviewer` is the only registered reviewer and can never produce an `AUTHORITATIVE` verdict; real Claude CLI review is a later, separately approved milestone.
- A review verdict never commits, merges, or accepts an execution.
