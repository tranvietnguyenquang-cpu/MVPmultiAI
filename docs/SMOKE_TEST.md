# Relay v2 Milestone 2.1 smoke test

Status: manual checklist for implemented projects, tasks, approvals, SQLite execution, FakeExecutor, SSE, artifacts, and cancellation. It contains no real provider, command, Git mutation, MCP, or deployment step.

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

## Expected limitations

- FakeExecutor only; no real AI CLI or API.
- No Git status, checkpoint, diff, test command, source write, Docker, or deployment behavior.
- Expired active sessions recover to `BLOCKED`; automatic retry is intentionally not implemented.
- Artifact retention cleanup is planned.
