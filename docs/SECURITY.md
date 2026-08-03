# Relay v2 security boundaries

Status: Milestones 2 through 2.3A are implemented and tested, including the approval-bound Codex CLI process boundary and the evidence-bound review foundation. No Claude/API/MCP/deployment integration is present.

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

## Review authority (Milestone 2.3A)

Only `ReviewEngine` changes `ReviewRequest` status. A reviewer never gains authority merely by being registered: `resolveReviewerAuthority` independently checks that the task approval used for the execution is `APPROVED`, that its reviewer selection is not `NONE`, that the task's current reviewer selection still matches the approval snapshot, and that the requested reviewer id matches what the approved selection resolves to. In Milestone 2.3A that resolution map is empty (no Claude reviewer exists), so `fake-reviewer` can never produce an `AUTHORITATIVE` verdict for a `codex-cli` execution — only two narrow, separately-gated `DIAGNOSTIC` paths exist: a `FakeExecutor` diagnostic session (engine flag + explicit per-request `diagnostic: true`), and a Codex test-double session in the disposable Playwright browser-test environment (`PROJECT_RELAY_TEST_MODE` + `RELAY_V2_FAKE_REVIEWER_DIAGNOSTIC` + the `playwright-v2` data directory, mirroring the existing Codex process test-double gate exactly). Every review's `reviewAuthority` (`AUTHORITATIVE`/`DIAGNOSTIC`) is bound into its `requestHash`, persisted immutably once terminal, and a `DIAGNOSTIC` verdict can never satisfy a future auto-commit gate — there is no upgrade path.

A review request cryptographically binds, at request time, to one canonical `ReviewInputCapsule` — every stored execution evidence and reviewer-authority field (spec hash, approval id/status/reviewer-selection snapshot, executor id, capsule, baseline/final Git evidence, verification results, artifact set, final branch/HEAD, review authority) **plus** live-read task title/objective/context, execution status/summary, and two independent spec-integrity recomputations (`canonicalTaskSpecHash` against the approval's embedded spec, `taskNormalizedSpecHash` against the task's current `normalizedSpecJson`) — persisted verbatim as `reviewInputJson`/`reviewInputHash`. **The reviewer's own configuration is bound too, not only the evidence capsule**: for FakeReviewer, `reviewerConfigJson` (outcome/delay/summary/findings/required-actions) directly controls the verdict, so it is validated against a per-reviewer schema, canonicalized, and hashed into `reviewerConfigHash`, persisted alongside `reviewerConfigJson`. `requestHash = sha256(canonicalJson({ reviewInputHash, reviewerConfigHash, reviewerId, reviewAuthority, requestedBy, attempt, reviewPolicyVersion }))` binds both hashes together with the request's authority/administrative identity. The execution capsule hash is never trusted from a single column: it is independently recomputed from the capsule's own self-referential embedded hash and required to match the stored column. `Reviewer.review()` receives exactly the object parsed back from the persisted `reviewInputJson`, plus the object parsed back from the persisted `reviewerConfigJson` — never task/execution fields reassembled from live rows at run time, and never an unbound reviewer configuration, so a title/objective/summary/scenario change can neither reach the reviewer unbound nor drift after the hash is computed.

`ReviewEngine` never trusts a persisted hash merely because the database protects it (below): it independently re-parses, re-validates, and re-hashes `reviewInputJson` and `reviewerConfigJson` and reconstructs `requestHash` from scratch, both immediately before the reviewer is ever invoked and again inside the finalization transaction. A mismatch at either point — a corrupt, imported, or legacy row — transitions the request straight to `STALE` with `failureCode: "REVIEW_IMMUTABLE_INPUT_MISMATCH"`, the reviewer is never called, and no verdict is ever inserted. Immediately before a verdict is persisted, in the same database transaction as the terminal status CAS and the `ReviewVerdict` insert, the engine additionally re-reads every source-of-truth row fresh, re-runs eligibility, spec-integrity, and authority resolution, and reconstructs the full `ReviewInputCapsule` — any live-evidence change (including task title/objective/context/normalized-spec drift) moves the request to `STALE` with `failureCode: "EVIDENCE_CHANGED"` (with the specific reason recorded) instead of accepting the verdict — the two failure codes are kept distinct so the audit trail always records whether the binding itself was corrupted or evidence simply moved on. A terminal request can never be updated again (SQLite trigger, not just application logic), and neither can the authority/evidence/binding payload of a non-terminal one — a second SQLite trigger, `ReviewRequest_immutable_payload`, rejects any change to `reviewInputJson`/`reviewInputHash`/`reviewerConfigJson`/`reviewerConfigHash`/`requestHash`/`reviewerId`/`reviewAuthority`/every evidence hash/identity field in *every* status (`PENDING`/`CLAIMED`/`RUNNING`/`CANCELLATION_REQUESTED` included), permitting only the controlled lifecycle/lease columns to change. `ReviewVerdict` and `ReviewEvent` are append-only, enforced both by SQLite triggers and — for `ReviewVerdict.reviewRequestId` specifically — a database-level `UNIQUE` constraint, so a second verdict for the same review request fails at the database regardless of how it is attempted, independent of the application-level CAS. A structurally invalid or hash-mismatched reviewer response becomes `ERROR`, never `APPROVE`.

Cancellation and verdict finalization race safely: cancelling a claimed/running review is a compare-and-swap `UPDATE ... WHERE status IN (...)` into a durable `CANCELLATION_REQUESTED` state committed *before* the in-process abort signal fires, and verdict/error/stale finalization is a matching CAS scoped to the exact claimed ownership generation (`ownerId`, `leaseToken`, `claimAttempts`, live `leaseExpiresAt`) — exactly one of the two can ever win, and the loser's write is dropped, never a partial or duplicate terminal outcome. Every terminal write re-proves that ownership generation is still live immediately before writing: an expired lease (heartbeats stopped, or the owner paused) or a superseded claim generation (reclaimed by recovery or a new owner) can never produce a verdict — only `recoverStaleReviews` or a still-live owner's own race-resolution path may touch an ownerless row, and an expired owner is never revived. API routes never invoke a reviewer directly; they only create a `PENDING` row, and a durable `ReviewRuntimeHost` atomically claims (`CAS PENDING -> CLAIMED` with an owner id, lease token, claim-attempt counter, and heartbeat-renewed expiry) and runs it, so a crashed request or restarted process can never strand or silently drop a review — an expired lease recovers conservatively to `CANCELLED` (if cancellation was already requested) or `STALE` (otherwise), and no verdict is ever invented during recovery.

A review verdict changes only a separately computed `ReviewGateProjection` (`state`/`authority`/`reviewerId`/`reviewRequestId`/`verdictId`/`requestHash`/`commitAuthorityEligible`) — never a plain status string, so a `DIAGNOSTIC` `APPROVE` is always visibly diagnostic in every API response and UI surface, and never a plain `ExecutionSession`/`Task` status mutation, Codex reopen/rerun, file modification, or Git operation. `commitAuthorityEligible` and `canSatisfyAuthoritativeReviewGate` unconditionally return `false`/deny in this milestone — there is no auto-commit policy yet, so no caller can derive commit authority from `verdict === APPROVE` alone. `fake-reviewer` is the only registered reviewer and is read-only and in-process. The `relay-v2-reviewer` package depends only on `relay-v2-domain`, `relay-v2-persistence`, `local-safety`, and `zod`; it cannot import `SafeProcessRunner` or `node:child_process`, which dependency-isolation tests enforce directly.

## Planned

Real Claude CLI review (Milestone 2.3B), an auto-commit gate (Milestone 2.4), broader operation-risk catalogs, dedicated dangerous-operation approvals, secure API credentials, and MCP remain later work. Automatic Git mutation and deployment are not present.
