# Relay v2 Milestone 1 smoke test

Status: manual checklist for the implemented local project/task workflow. It intentionally contains no executor, provider API, MCP, deployment, or remote-bridge steps.

## Setup

1. Confirm `git status --short` and preserve unrelated changes.
2. Set `RELAY_V2_DATA_DIR` to a new disposable directory under the repository's ignored `.relay-data` directory.
3. Set `RELAY_V2_DATABASE_URL` to `file:<that-directory>/relay-v2.db` and run `npm run db:v2:migrate`.
4. Set `RELAY_V2_ENABLED=true` and start only the existing web application.
5. Open `http://localhost:3300/v2`.

## Projects

- Open **Projects**, choose **Add project**, and register an absolute path to a local Git repository.
- Verify a non-existent path and a directory without `.git` show a clear error.
- Verify the project appears in `/v2/projects` and a `PROJECT_CREATED` audit event exists in SQLite.

## Manual task

- Open **Create Task**, choose the project, and fill title, objective, one acceptance criterion, executor/model/effort/reviewer, and optional context/constraints.
- Choose **Create pending task**.
- Verify the task detail status is `PENDING_APPROVAL`, selections and spec hash are visible, and audit history includes creation and submission.
- Verify no worker, provider, or agent process starts and no queue job appears in the legacy application.

## Handoff import

- Open **Import Handoff** and use **Copy template**.
- Paste a valid YAML handoff, validate it, and inspect the normalized preview and hash.
- Create the task and verify it is `PENDING_APPROVAL`.
- Repeat with a JSON file and a YAML file.
- Try **Import from clipboard**. If browser permission is denied, verify the UI explains that ordinary paste is the fallback.
- Try malformed YAML, malformed JSON, a missing objective, an unsupported tag such as `!unsafe`, and a file larger than 262,144 bytes. Verify clear field-level errors and no task creation.
- Put a fake credential-shaped value such as `api_key=supersecretvalue123` in context and verify persistence is rejected.

## Duplicate handling

- Submit the same imported handoff to the same project twice.
- Verify the second submission returns the existing task rather than creating another row.
- Reuse the same idempotency key with changed content through the API and verify a conflict.

## Approval and edit invalidation

- From a pending task, open **Approval View** and verify the hash, executor, model, effort, reviewer, and permissions.
- Choose **Approve without executing** and verify status becomes `APPROVED` while the page states that no execution was queued.
- Edit the normalized task JSON, change the objective, and save.
- Verify status returns to `PENDING_APPROVAL`, the previous approval is `INVALIDATED`, and a new pending approval has the new hash.
- Approve again, then use **Cancel task** and verify `CANCELLED` plus its audit event.

## Legacy preview

- If the legacy PostgreSQL database is available, open **Legacy preview**, select rows, and create a report.
- Verify source/candidate/skipped counts and reasons are shown.
- Verify legacy approvals are counted as skipped and no v2 approval is created.
- Verify no source row changes. If PostgreSQL is unavailable, record the preview as skipped; this must not block the v2 task workflow.

## Automated verification

Run:

```powershell
npm run test:v2
npm run typecheck
npm run lint
npm run build
npm run test:browser:v2
```

Record exact pass/fail/skip outcomes. The browser suite recreates a disposable SQLite database before every run and deliberately points legacy PostgreSQL/Redis URLs at unreachable test ports, proving the tested v2 flow does not depend on them. The ignored `.relay-data/playwright-v2` directory may remain after the server stops and is replaced on the next run.

## Expected limitations

- `APPROVED` is terminal for implemented Milestone 1 behavior except cancellation or edit-driven reapproval.
- No code execution, review run, live process logs, Git checkpoint, or diff capture exists yet.
- Legacy data import is disabled; only a read-only preview/report is implemented.
