# Relay v2 review engine

Status: **implemented and tested for Milestone 2.3A only**. FakeReviewer is the only registered reviewer and is diagnostic-only in every runtime — it can never produce an AUTHORITATIVE verdict. No Claude CLI, Anthropic API, OpenAI API, Gemini, DeepSeek, or MCP integration exists. A review verdict never commits, merges, reopens execution, or accepts a task.

## Lifecycle

```text
Codex execution -> AWAITING_USER_ACCEPTANCE -> Review Request (PENDING) -> ReviewRuntimeHost claims it -> RelayReviewer -> immutable StructuredReviewVerdict
```

`ReviewRequest` is a mutable state-machine aggregate scoped to one execution session. `ReviewVerdict` and `ReviewEvent` are append-only (enforced by SQLite triggers, not just application code). A terminal `ReviewRequest` row cannot be updated at all — a second trigger rejects any `UPDATE` once `status` is one of `APPROVED, REJECTED, NEEDS_CHANGES, ERROR, CANCELLED, STALE`.

Review status transitions:

```text
PENDING -> CLAIMED | CANCELLED | STALE | ERROR
CLAIMED -> RUNNING | CANCELLATION_REQUESTED | ERROR | STALE
RUNNING -> CANCELLATION_REQUESTED | APPROVED | REJECTED | NEEDS_CHANGES | ERROR | STALE
CANCELLATION_REQUESTED -> CANCELLED | ERROR | STALE
APPROVED | REJECTED | NEEDS_CHANGES | ERROR | CANCELLED | STALE -> terminal
```

`CLAIMED` and `CANCELLATION_REQUESTED` exist so that durable ownership and cancellation are each a committed database state, not just an in-memory event — see "Durable claiming and ownership" and "Cancellation and finalization races" below. Only `ReviewEngine` changes `ReviewRequest` status; no route, UI action, reviewer implementation, or test helper writes a terminal status directly, and API request handlers **never invoke a reviewer directly** — they only create a `PENDING` row.

## Reviewer authority (who may review what)

A reviewer never gains authority merely by being registered in the runtime. Before a `ReviewRequest` is created, `resolveReviewerAuthority` (`packages/relay-v2-reviewer/src/reviewer-authority.ts`) independently re-derives and checks:

- the task approval used for this execution is `APPROVED` (not `PENDING`/`REJECTED`/`INVALIDATED`);
- the approval's reviewer selection is not `NONE`;
- the task's *current* reviewer selection still matches the approval's reviewer selection — if it changed since approval, authority is denied and a new task approval is required;
- the execution's executor id, matched against the requested reviewer id.

This is a pure function, independently unit-tested (`reviewer-authority.test.ts`) against every rule above without depending on whether a real reviewer exists yet.

Two narrow, explicitly-gated diagnostic paths exist, and only these two:

1. **FakeExecutor diagnostic sessions.** Requires both the engine-level `allowFakeExecutorDiagnosticReviews` flag (on only when `PROJECT_RELAY_TEST_MODE=true`) and the caller's explicit `diagnostic: true`. Only `fake-reviewer` may review a `fake`-executor session.
2. **Codex test-double sessions in browser tests.** Requires `diagnostic: true` **and** the engine-level `allowCodexTestDoubleDiagnosticReviews` flag, which mirrors the existing Codex process test-double gate exactly: `PROJECT_RELAY_TEST_MODE=true`, a dedicated `RELAY_V2_FAKE_REVIEWER_DIAGNOSTIC=true`, and `RELAY_V2_DATA_DIR` pointing at the disposable `playwright-v2` directory. All three must hold.

Outside those two gates, `fake-reviewer` is rejected for every `codex-cli` session — including in ordinary local/production runtime, where no reviewer selection maps to a runtime reviewer id at all (the map is empty; no placeholder Claude implementation exists). This is exactly how "normal Codex execution awaits the future Claude reviewer (Milestone 2.3B)" is enforced today: there is no code path by which any registered reviewer can produce an AUTHORITATIVE verdict yet.

Every review produced under either diagnostic gate is marked `reviewAuthority: "DIAGNOSTIC"` and persisted that way for the life of the row (immutable once terminal, like every other bound field). There is no code path that converts a `DIAGNOSTIC` review to `AUTHORITATIVE`.

## The immutable ReviewInputCapsule binding

Everything the reviewer is allowed to see — and everything the request is bound to — is one canonical `ReviewInputCapsule` (`packages/relay-v2-reviewer/src/review-binding.ts`): `reviewRequestId`, `executionSessionId`, `projectId`, `taskId`, `reviewerId`, `reviewAuthority`, `diagnostic`, `approvalId`, `approvalStatus`, `approvedReviewer`, `taskSelectedReviewer`, `executionExecutorId`, `taskTitle`, `taskObjective`, `taskContext`, `taskSpecHash`, `canonicalTaskSpecHash`, `taskNormalizedSpecHash`, `approvalSnapshotHash`, `executionStatus`, `executionResultStatus`, `executionSummary`, `executionSummaryHash`, `executionCapsuleHash`, `executionCapsuleJsonHash`, `baselineGitEvidenceHash`, `finalGitEvidenceHash`, `verificationResultsHash`, `executionArtifactSetHash`, `finalBranch`, `finalHead`, `requestedAt`, `reviewPolicyVersion`.

Crucially, `taskTitle`, `taskObjective`, and `taskContext` are **live-read** directly from the `Task` row's own columns at capsule-build time — not derived only from `taskSpecHash` — so a bug or direct mutation that changes them without bumping the task's spec version is still hash-visible. Two independent integrity checks reinforce this:

- `canonicalTaskSpecHash` recomputes `hashTaskSpec` over the normalized spec actually embedded in the approval snapshot (`approval.approvedSpecJson`) and must equal `taskSpecHash`; a mismatch fails eligibility with "The task specification failed integrity verification" before a review can even be requested, and fails revalidation the same way.
- `taskNormalizedSpecHash` recomputes `hashTaskSpec` over the task's *current* `normalizedSpecJson` column, so a direct mutation to that column (leaving `specHash` untouched) still changes the capsule hash.
- `executionCapsuleJsonHash` is independently recomputed from the *current* raw `capsuleJson` column on every read — never trusted from a cached value — alongside `executionCapsuleHash` (the stored, self-referential column, verified separately via `verifyCapsuleIntegrity`).

The capsule is canonically serialized and hashed into `reviewInputHash = sha256(canonicalJson(capsule))`, persisted verbatim as `ReviewRequest.reviewInputJson`/`reviewInputHash`.

**Every value that can affect `RelayReviewer.review()`'s behavior is bound, not just the evidence capsule.** For FakeReviewer, `reviewerConfigJson` (the scenario config: `outcome`, `delayMs`, `summary`, `findings`, `requiredActions`) directly determines whether the reviewer approves, rejects, requests changes, fails, or blocks on cancellation — it is authority-affecting reviewer input, exactly like the evidence capsule. It is validated against a per-reviewer schema (`reviewerConfigSchemaFor(reviewerId)` in `review-engine.ts`; `fake-reviewer` → `fakeReviewerScenarioSchema.strict()`, any other/unregistered reviewer id → an empty `.strict()` object, so no reviewer can accept undeclared configuration), canonicalized, and hashed into `reviewerConfigHash = sha256(canonicalJson(validated config))`, persisted alongside `reviewerConfigJson`.

`requestHash = sha256(canonicalJson({ reviewInputHash, reviewerConfigHash, reviewerId, reviewAuthority, requestedBy, attempt, reviewPolicyVersion }))` — it binds both hashes together with the request's authority/administrative identity. `reviewerId`/`reviewAuthority`/`reviewPolicyVersion` are already inside the capsule too; repeating them here means `requestHash` is independently reconstructible without dereferencing into `reviewInputJson`. `requestedBy`/`attempt` are not themselves reviewer-visible input, so they live outside `reviewInputHash` and `reviewerConfigHash`.

`Reviewer.review()` receives exactly the object parsed back from the persisted `reviewInputJson`, plus the object parsed back from the persisted `reviewerConfigJson` (for `fake-reviewer`, its `scenario`) — never task/execution fields re-assembled from live rows at run time, and never a reviewer configuration appended unbound. This closes the gap where a title/objective/summary change, or an unbound reviewer scenario, could previously reach the reviewer, or change between request and verdict, without ever being reflected in `requestHash`.

## Runtime self-validation of the immutable input binding

The database trigger described below (see "Database-enforced active-payload immutability") normally makes it impossible to *change* `reviewInputJson`/`reviewerConfigJson`/their hashes once a row exists — but `ReviewEngine` never trusts a persisted hash merely because the trigger protects it. `ReviewEngine.verifyImmutableInputBinding(row)` independently re-derives the binding from scratch every time it matters:

1. parse `reviewInputJson`, validate it against `reviewInputCapsuleSchema`, recompute its hash from the canonicalized validated value, and require it to equal the persisted `reviewInputHash`;
2. parse `reviewerConfigJson`, validate it against the reviewer's own config schema, recompute its hash, and require it to equal the persisted `reviewerConfigHash`;
3. reconstruct `requestHash` from those two (now-reverified) hashes plus the row's own `reviewerId`/`reviewAuthority`/`requestedBy`/`attempt`/`reviewPolicyVersion`, and require it to equal the persisted `requestHash`.

This runs in two places: **before the reviewer is ever invoked** (inside `runClaimed`, immediately after the `CLAIMED -> RUNNING` transition) — a failure here transitions the row straight to `STALE` with `failureCode: "REVIEW_IMMUTABLE_INPUT_MISMATCH"` and the reviewer is **never called**; and again as the first step of `revalidateForVerdict`, inside the same lease-qualified finalization transaction, before any live evidence reconstruction. A corrupt, imported, or legacy row (one that never went through `ReviewEngine.requestReview`, or whose columns were seeded directly) is caught either way, never silently repaired, and never allowed to produce a verdict.

## Final verdict revalidation

Immediately before accepting any verdict, `ReviewEngine.revalidateForVerdict` runs **inside the same database transaction** as the ownership check and the terminal CAS (see "Lease-bound verdict finalization" below) and re-reads every source-of-truth row fresh via that transaction (never the `ReviewRequest` row's own snapshot columns). It first re-verifies the immutable input binding itself (above; a failure here is reported with `code: "REVIEW_IMMUTABLE_INPUT_MISMATCH"`), then re-runs, in order: project ownership, task-spec-unchanged-since-execution, the full session eligibility check (status, task status, lease released, capsule/evidence/verification/artifacts presence, capsule integrity), the approval's continued existence and unchanged snapshot hash, the spec-integrity check, and reviewer-authority resolution again (including that the resolved mode still equals the mode recorded at request time). It then reconstructs the *entire* `ReviewInputCapsule` from the fresh rows and requires it to reproduce the original `requestHash` bit-for-bit (a failure here is reported with `code: "EVIDENCE_CHANGED"`) — these two failure codes are deliberately distinct, so the audit trail records whether the persisted request itself was corrupted or whether live evidence simply moved on.

Any drift at all — corrupted input binding, evidence, task title/objective/context, approval, task status, execution status, reviewer authority, or capsule integrity — is reported as a specific reason string and failure code, and the engine does **not** update the original request with new values and does **not** accept the verdict; it transitions the request to `STALE` (in the same transaction), writes a `REVIEW_STALE_INVALIDATED` event and audit event with that reason, and requires a new review request. A stale transition can only happen from `RUNNING` under the same live ownership that claimed it, so a terminal verdict is never retroactively invalidated and an expired/superseded owner can never write it.

The verdict itself is also required to echo `reviewedRequestHash` equal to the request's `requestHash`; a mismatch (including replaying a verdict computed for a different review or execution) becomes `ERROR`, never an accepted verdict.

## Database-enforced single verdict

`ReviewVerdict.reviewRequestId` carries a `UNIQUE` constraint at the database level (`schema.prisma` and the Milestone 2.3A migration), not only an application-level check — a second `INSERT` for the same `reviewRequestId` fails with a SQLite constraint violation regardless of how it is attempted, including a raw direct insert that bypasses `ReviewEngine` entirely. This is a second, independent backstop behind the application-level CAS described below: the CAS is what normally prevents a duplicate insert from ever being attempted, and the constraint is what guarantees the database itself never accepts one if it were. A dedicated test races two concurrent direct inserts against the *same* zero-verdict `ReviewRequest` and asserts exactly one succeeds — not against a request that already has a verdict, which would only prove the constraint rejects a second insert, not that it correctly arbitrates a genuine race for the first one.

## Database-enforced active-payload immutability

The terminal-immutable trigger (above) only blocks updates once a row reaches a terminal status. A `BEFORE UPDATE` trigger, `ReviewRequest_immutable_payload`, additionally rejects any change to the request's authority/evidence/binding payload **in every status** — `PENDING`, `CLAIMED`, `RUNNING`, and `CANCELLATION_REQUESTED` included — by comparing `OLD` and `NEW` on each protected column and raising a constraint error if any differs:

`executionSessionId`, `projectId`, `taskId`, `reviewerId`, `reviewAuthority`, `diagnosticRequested`, `approvalId`, `approvalStatus`, `approvalReviewerSelection`, `taskSelectedReviewer`, `executionExecutorId`, `attempt`, `taskSpecHash`, `approvalSnapshotHash`, `executionCapsuleHash`, `baselineGitEvidenceHash`, `finalGitEvidenceHash`, `verificationResultsHash`, `executionArtifactSetHash`, `executionResultStatus`, `finalBranch`, `finalHead`, `reviewPolicyVersion`, `reviewInputJson`, `reviewInputHash`, `reviewerConfigJson`, `reviewerConfigHash`, `requestHash`, `requestedBy`, `requestedAt`.

Only the controlled lifecycle/lease columns remain mutable: `status`, `ownerId`, `leaseToken`, `claimedAt`, `heartbeatAt`, `leaseExpiresAt`, `cancellationRequestedAt`, `claimAttempts`, `startedAt`, `finishedAt`, `invalidatedAt`, `failureCode`, `failureMessage`. This is a database-level backstop, not merely an application convention — a direct or buggy write that bypasses `ReviewEngine` entirely still cannot alter the bound payload of an in-flight review, only its lifecycle state.

## Cancellation and finalization races (CAS)

Cancelling a `CLAIMED` or `RUNNING` review is a compare-and-swap `UPDATE ... WHERE status IN (...)` into `CANCELLATION_REQUESTED`, committed to the database *before* the in-process `AbortController` is aborted — the durable state, not the abort signal, is the source of truth. Verdict finalization is a matching CAS, scoped to the exact ownership generation that claimed the review (see below): `UPDATE ... WHERE status = 'RUNNING' AND ownerId = ... AND leaseToken = ... AND claimAttempts = ... AND leaseExpiresAt > now()` into the terminal verdict status, in the same transaction as revalidation and inserting the `ReviewVerdict` row. Exactly one of these two writes can ever succeed for a given row:

- If cancellation's CAS wins first, the verdict-finalization CAS later matches zero rows, so **no `ReviewVerdict` row is ever inserted** — `resolveFinalizationRace` resolves the row to `CANCELLED`, but *only* if the caller attempting to resolve it still holds the exact ownership generation it started with and that lease has not itself expired; otherwise it is a no-op and `recoverStaleReviews` is the only path left that may touch the row.
- If the verdict's CAS wins first, the row is already terminal, so a subsequent `cancelReview` call's CAS also matches zero rows and returns `alreadyTerminal: true` without altering anything.

The same discipline applies to `ERROR` transitions (`finalizeNonVerdict`): each is an ownership-scoped `WHERE status IN ('CLAIMED', 'RUNNING')` CAS (matching whichever status the row is expected to be in at that call site — including the case where the registered reviewer disappeared before ever reaching `RUNNING`), and losing that race falls back to `resolveFinalizationRace` instead of silently doing nothing. Repeated concurrent `cancelReview` calls are idempotent — only the first appends a `REVIEW_CANCELLATION_REQUESTED` event; replays observe the same in-flight or terminal state without duplicating it.

## Lease-bound verdict finalization

Every terminal write — verdict, `STALE`, or `ERROR` — must re-prove current ownership immediately before it happens, in the same transaction as the write itself. `runClaimed` captures the exact ownership generation (`ownerId`, `leaseToken`, `claimAttempts`) once, right after reading the `CLAIMED` row, and threads it through the `CLAIMED -> RUNNING` transition, revalidation, and every finalize call. The terminal CAS's `WHERE` clause requires all of: `status` matches the expected pre-terminal status, `ownerId` matches, `leaseToken` matches, `claimAttempts` matches, and `leaseExpiresAt > now()` (lease not expired — since every heartbeat call extends `leaseExpiresAt`, a paused/GC'd owner whose heartbeats stopped naturally fails this check without any separate "heartbeat freshness" column).

If ownership is expired, lost, or superseded by a new claim generation, no verdict (or any other terminal write) is ever produced by that caller — `resolveFinalizationRace` is the only recourse, and it itself re-checks ownership before doing anything, so an expired or reclaimed owner is never revived. `recoverStaleReviews` (below) is the only other path allowed to resolve an ownerless row. `leaseToken` is a fresh `randomUUID()` per claim, so it alone already disambiguates a claim generation; `claimAttempts` is matched too as an explicit, literal, independent predicate.

## Durable claiming, ownership, and recovery

API route handlers only ever call `ReviewEngine.requestReview`, which creates a `PENDING` row and returns — **no fire-and-forget promise runs the reviewer**. A `ReviewRuntimeHost` (`runtime-host.ts`, mirroring the execution engine's `ExecutionRuntimeHost`) polls and atomically claims pending reviews via `ReviewEngine.claimNext(ownerId)`, an `UPDATE ... WHERE status = 'PENDING'` CAS that sets `ownerId`, `leaseToken`, `claimedAt`, `heartbeatAt`, `leaseExpiresAt`, and `claimAttempts` in one statement. Multiple `ReviewRuntimeHost` instances (each with a distinct `ownerId`) may safely share one database — the claim CAS guarantees only one ever owns a given review, proven by concurrently claiming from two engine instances in `review-engine.test.ts`.

While a review runs, a heartbeat timer renews `heartbeatAt`/`leaseExpiresAt` via `ReviewEngine.heartbeat(reviewRequestId, leaseToken)`, which itself is lease-token-validated. `ReviewEngine.recoverStaleReviews()` finds any `CLAIMED`/`RUNNING`/`CANCELLATION_REQUESTED` row whose lease has expired and resolves it conservatively:

- if cancellation was already requested (`cancellationRequestedAt` set), it recovers to `CANCELLED` — safe, because cancellation was already authorized;
- otherwise, uncertain active ownership recovers to `STALE` with `failureCode: "STALE_LEASE"` — **no verdict is ever invented during recovery**, and a new review request is required.

A `PENDING` review that was never claimed survives a restart unchanged and remains claimable by a brand-new engine/host instance sharing the same database. Every terminal transition (verdict, error, stale, cancelled, or stale-lease recovery) clears the lease fields in the same statement that sets the terminal status — required because the terminal-immutable SQLite trigger blocks any later `UPDATE` on that row, lease-clearing included.

## Reviewer contract

```ts
interface RelayReviewer {
  readonly id: string;
  describe(): ReviewerDescriptor;
  validate(request: ReviewerValidationRequest): Promise<ReviewerValidationResult>;
  review(capsule: ImmutableReviewCapsule, controls: ReviewControls): Promise<StructuredReviewVerdict>;
  cancel?(reviewRequestId: string): Promise<void>;
  health(): Promise<ReviewerHealth>;
}
```

`ImmutableReviewCapsule` is exactly the persisted `ReviewInputCapsule` (see above) plus `requestHash` and, for FakeReviewer only, its persisted `scenario` — never a workspace path, credential, or live process handle, and never any field assembled outside the capsule. Milestone 2.3A registers only `fake-reviewer`; no placeholder Claude/API reviewer code exists.

## Structured verdict validation

`StructuredReviewVerdict` is Zod-validated with `.strict()` (unknown fields are rejected, not silently granted authority) and cross-field invariants:

- `APPROVE` cannot contain a blocking `BLOCKER` or `HIGH` finding.
- `REJECT` must contain at least one blocking finding.
- `NEEDS_CHANGES` must contain at least one required action.

A reviewer's free-form summary text carries no authority over the verdict. Any structurally invalid reviewer response — including a deliberately malformed one — becomes `ERROR`, never `APPROVE`.

## Eligibility

A review may be requested only when: the execution session belongs to the requesting project; the execution session reached `SUCCEEDED` and the task reached `AWAITING_USER_ACCEPTANCE`; the workspace lease is released; the execution capsule and baseline/final Git evidence exist and pass self-referential integrity for Codex sessions; verification results exist whenever verification operations were approved; at least one execution artifact was recorded; the approval snapshot used for the execution can still be located; and reviewer authority resolves to `AUTHORITATIVE` or `DIAGNOSTIC` per the rules above (never for reviewer selection `NONE`, never for a reviewer that does not match the approved selection). A `FAILED`, `CANCELLED`, `TIMED_OUT`, `BLOCKED`, or still-running execution structurally cannot reach `AWAITING_USER_ACCEPTANCE`, so it can never receive any verdict — including `APPROVE` — through this path.

Only one active (`PENDING`/`CLAIMED`/`RUNNING`/`CANCELLATION_REQUESTED`) review may exist per execution session; this is enforced both in the transaction and by a SQLite partial unique index. A duplicate request while one is active returns the existing request instead of creating a second one. A new request after a prior terminal review is a fresh row with an incremented `attempt`.

## Execution-status interaction

Milestone 2.3A never creates execution success truth from reviewer prose and never re-derives execution/task status from a review. The execution session remains `SUCCEEDED` and the task remains `AWAITING_USER_ACCEPTANCE` regardless of verdict. `ReviewEngine.reviewGateProjection` is computed on read from the latest non-cancelled `ReviewRequest` for the session — it is not a stored `ExecutionSession` column, so this milestone requires no change to the already-committed execution schema/migrations.

`ReviewEngine` never reopens the Codex process, reruns Codex, creates a new task, modifies files, accepts the execution, or commits changes. Those actions are explicitly out of scope until a later milestone.

## Authority-preserving review gate projection

Nothing projects a review onto its execution session as a plain status string — that representation is lossy: it cannot distinguish a `DIAGNOSTIC` `APPROVE` (which must never satisfy a future commit gate) from an `AUTHORITATIVE` one. `ReviewEngine.reviewGateProjection(executionSessionId)` instead returns a `ReviewGateProjection` (`packages/relay-v2-domain/src/review.ts`):

```ts
type ReviewGateProjection = {
  state: "NOT_REQUESTED" | "PENDING" | "RUNNING" | "APPROVED" | "REJECTED" | "NEEDS_CHANGES" | "ERROR" | "CANCELLED" | "STALE";
  authority: "NONE" | "AUTHORITATIVE" | "DIAGNOSTIC";
  reviewerId: string | null;
  reviewRequestId: string | null;
  verdictId: string | null;
  requestHash: string | null;
  commitAuthorityEligible: boolean;
};
```

`state` is a coarser, externally-facing view of the underlying `ReviewRequestStatus` state machine: `CLAIMED` and `CANCELLATION_REQUESTED` both project as `RUNNING` ("in flight, not yet resolved"), while the full granularity is retained internally on the `ReviewRequest` row itself. `authority` is `NONE` only when no review has ever been requested for the session; otherwise it is the review's assigned `reviewAuthority`, so a `DIAGNOSTIC APPROVE` is always visibly diagnostic and never indistinguishable from an authoritative one.

`commitAuthorityEligible` is **always `false`** in Milestone 2.3A — there is no auto-commit policy yet. `canSatisfyAuthoritativeReviewGate(projection)` is the single centralized gate any future commit/auto-accept policy must call; in this milestone it unconditionally returns `false` regardless of `state`, `authority`, or a caller-supplied `commitAuthorityEligible`, so no caller can derive commit authority from `verdict === APPROVE` alone, diagnostic or authoritative. A later milestone must replace this function deliberately.

## FakeReviewer

In-process, read-only, and diagnostic-only. It never imports `SafeProcessRunner`, `node:child_process`, or any filesystem/network module, and is excluded from that dependency edge entirely — the `relay-v2-reviewer` package depends only on `relay-v2-domain`, `relay-v2-persistence`, `local-safety`, and `zod`.

Deterministic scenarios: `approve`, `reject`, `needs_changes`, `invalid` (deliberately produces a structurally invalid combination so `ReviewEngine`'s own re-validation — not the reviewer's self-report — turns it into `ERROR`), `failure` (throws), and `cancellation` (blocks until cancelled). `delayMs` is honored through injected `ReviewControls.sleep`, so tests use fast/deterministic timing. The scenario is authority-affecting input — it directly determines the verdict — so it is validated, canonicalized, hashed into `reviewerConfigHash`, and persisted as `ReviewRequest.reviewerConfigJson`/`reviewerConfigHash` (see "The immutable ReviewInputCapsule binding"), so it is neither lost if a runtime restarts before the review completes nor mutable afterward. The UI clearly labels every FakeReviewer review as `DIAGNOSTIC` wherever it is shown, and never as production approval.

## API

Loopback-protected, project-scoped, CSRF-protected on mutation:

- `POST /api/v2/executions/{id}/reviews?projectId=` — request a review. Only creates the `PENDING` row; the runtime host processes it separately.
- `GET /api/v2/executions/{id}/reviews?projectId=` — list reviews for an execution and its computed `reviewGate` (`ReviewGateProjection`, see above — never a plain status string). Ownership is checked against the execution session itself (`ReviewEngine.getExecutionSessionProject`) **before** touching any `ReviewRequest` row, so a wrong-project or nonexistent execution is indistinguishable from one with zero reviews.
- `GET /api/v2/reviews/{id}?projectId=` — review detail (verdicts, events).
- `GET /api/v2/reviews/{id}/events?projectId=&cursor=` — review event log.
- `POST /api/v2/reviews/{id}/cancel?projectId=` — cancel a non-terminal review.
- `GET /api/v2/reviewers/fake-reviewer/health` — FakeReviewer descriptor/health.

Every route verifies project, execution, and review ownership before touching any row; a nonexistent resource and a resource owned by a different project return the identical not-found response. No route imports or invokes process execution or a reviewer directly.

## UI

`/v2/executions/{id}` gained a **Review Gate** section built from `reviewGateProjection`: a gate-status pill *and* a separate authority pill shown side by side (never a bare status alone), an explicit "Commit-authority eligible: no" line, a **Request Review** action with the FakeReviewer diagnostic scenario selector, and links to prior review attempts (each labeled `Diagnostic approval` rather than plain `APPROVED` when the review is a `DIAGNOSTIC` approve). It explicitly states that requesting a review never re-opens, reruns, or modifies the execution.

`/v2/reviews/{id}` shows the linked execution/task/project, reviewer id and **authority** (`AUTHORITATIVE`/`DIAGNOSTIC`, always `DIAGNOSTIC` today), reviewed evidence hashes, verification summary, final Git branch/HEAD identity, the review event timeline, the structured verdict with findings grouped by severity and required actions, a stale banner when applicable, and a **Cancel Review** action while non-terminal. The status pill itself reads `Diagnostic approval` (not `APPROVED`) whenever the verdict is a `DIAGNOSTIC` approve, alongside the separate authority pill and an explicit "DIAGNOSTIC review... can never satisfy a future auto-commit or acceptance gate" note — no API response or UI surface ever collapses a diagnostic verdict back to a plain, unqualified status string. No commit, push, merge, retry, or deployment control exists anywhere in this UI, and the page states that approval does not commit or merge and that the execution still requires later user acceptance or an auto-commit policy.

## Planned

- **Milestone 2.3B**: a real Claude CLI reviewer adapter, capability-validated like `CodexCliExecutor`, registered alongside FakeReviewer, and the first reviewer that can produce an `AUTHORITATIVE` verdict.
- **Milestone 2.4**: an auto-commit gate that can act on an `APPROVED` review — not present yet. Today an `APPROVED` verdict changes only the `reviewGateProjection`; the execution still requires separate user acceptance, `commitAuthorityEligible` remains `false`, and a `DIAGNOSTIC` verdict can never satisfy that gate regardless of milestone.
