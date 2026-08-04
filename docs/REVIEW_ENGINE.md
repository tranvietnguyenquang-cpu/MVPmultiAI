# Relay v2 review engine

Status: **implemented and tested through Milestone 2.3B, including a fourth hardening pass** (artifact-store requirement made a real assertion rather than a skippable condition, a coordinated total material byte budget, and an enforced category-specific truncation policy — see "Eligibility" below and `docs/CLAUDE_REVIEWER.md`). FakeReviewer remains the diagnostic-only reviewer — it can never produce an AUTHORITATIVE verdict. `claude-cli` (`packages/relay-v2-claude-reviewer`) is a real, capability-validated, read-only local Claude Code CLI reviewer and is the first reviewer that can produce an AUTHORITATIVE verdict, gated behind a task's approved reviewer selection actually being `CLAUDE`. See `docs/CLAUDE_REVIEWER.md` for its full safety model. No Anthropic API, OpenAI API, Gemini, DeepSeek, or MCP integration exists — `claude-cli` invokes the local subscription-authenticated `claude` CLI as a subprocess, never an API. A review verdict never commits, merges, reopens execution, or accepts a task.

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

Outside those two gates, `fake-reviewer` is rejected for every `codex-cli` session. `PRODUCTION_REVIEWER_ID_BY_SELECTION` maps `CLAUDE -> "claude-cli"` (only entry; `CODEX` still has none), so a `codex-cli` execution whose task was approved with reviewer selection `CLAUDE` — and only that case — can produce an AUTHORITATIVE verdict, by requesting `claude-cli` specifically. Any other requested reviewer id, or a mismatched/changed reviewer selection, is rejected exactly as before.

Every review produced under either diagnostic gate is marked `reviewAuthority: "DIAGNOSTIC"` and persisted that way for the life of the row (immutable once terminal, like every other bound field). There is no code path that converts a `DIAGNOSTIC` review to `AUTHORITATIVE`.

## The immutable ReviewInputCapsule binding

Everything the reviewer is allowed to see — and everything the request is bound to — is one canonical `ReviewInputCapsule` (`packages/relay-v2-reviewer/src/review-binding.ts`): `reviewRequestId`, `executionSessionId`, `projectId`, `taskId`, `reviewerId`, `reviewAuthority`, `diagnostic`, `approvalId`, `approvalStatus`, `approvedReviewer`, `taskSelectedReviewer`, `executionExecutorId`, `taskTitle`, `taskObjective`, `taskContext`, `taskSpecHash`, `canonicalTaskSpecHash`, `taskNormalizedSpecHash`, `approvalSnapshotHash`, `executionStatus`, `executionResultStatus`, `executionSummary`, `executionSummaryHash`, `executionCapsuleHash`, `executionCapsuleJsonHash`, `baselineGitEvidenceHash`, `finalGitEvidenceHash`, `verificationResultsHash`, `executionArtifactSetHash`, `finalBranch`, `finalHead`, `requestedAt`, `reviewPolicyVersion`, plus (since the fourth corrective pass) `executionLogEvidence` — the execution's `LOG` artifact content, head+tail bounded from the exact bytes byte-level artifact validation already read and hash-verified (see "A fourth independent corrective pass" in `docs/CLAUDE_REVIEWER.md`).

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

## Canonical evidence artifact contracts

Every evidence artifact an AUTHORITATIVE review is built from has a **strict, versioned schema** in `packages/relay-v2-domain/src/evidence-artifacts.ts` (`EVIDENCE_ARTIFACT_SCHEMA_VERSION = "evidence-artifact-v1"`). The contracts live in the domain package because the producer (`relay-v2-execution`) and the consumer (`relay-v2-reviewer`) may not import each other — a single shared definition is the only way both sides can be held to the *same* schema rather than to two hand-maintained copies that drift.

| Category | Carries |
| --- | --- |
| `FINAL_GIT` | `schemaVersion`, `branch`, `head`, `clean`, `changedFileCount`, `changedFiles` (path/status/rename metadata/binary/baseline+final hashes), `fullEvidenceHash`, `captureEvidenceHash`, `capturedAt`, `forbiddenGitMutationSuspected`, `truncation` |
| `PATCH` | `schemaVersion`, `patchKind` (`FINAL`/`BASELINE`), `baselineHead`, `finalHead`, `unifiedDiff`, `coveredPaths`, `omittedPaths` (path + policy reason), `fullContentHash`, `truncation` |
| `CHANGED_FILES` | `schemaVersion`, `files`, `fileCount`, `manifestHash`, `truncation` |
| `VERIFICATION` | `schemaVersion`, per-operation identity/`displayCommand`/`status`/`exitCode`/`summary`/`stdout`/`stderr` with per-stream truncation provenance and `resultHash`, `fullContentHash`, `truncation` |
| `LOG` | a versioned **text**-artifact contract carried on the artifact row: `schemaVersion`, `contentType`, `encoding`, `rawContentHash`, `truncation` |

Every object is `.strict()`: an unknown, renamed, or added field is a hard parse failure, never a silently ignored one. A `schemaVersion` this build does not know is rejected outright.

## The artifact-to-database equality chain

The bytes on disk are the authoritative evidence. For `FINAL_GIT`, `PATCH`, `CHANGED_FILES`, and `VERIFICATION`, `ReviewEngine.validateAuthoritativeArtifactEvidence` runs this chain before any reviewer is invoked:

1. read the artifact bytes from the application-owned artifact store;
2. validate ownership (correct execution session) and bound artifact-set membership;
3. validate canonical containment (no absolute path, no `..`, no symlink/junction escape) and regular-file status;
4. validate the stored byte count against the raw bytes;
5. validate the stored SHA-256 against the raw bytes;
6. decode with the exact declared encoding, **strictly** (see "Strict UTF-8 and binary policy" in `docs/CLAUDE_REVIEWER.md`);
7. parse against the strict versioned artifact schema;
8. canonicalize the parsed artifact (`canonicalEvidenceSemantics`);
9. compute a canonical semantic hash (`semanticEvidenceHash`);
10. require the persisted database JSON to reduce — **through the same canonical semantics** — to a byte-identical value (`checkArtifactDatabaseEquality`).

Step 10 is the point of the whole chain. A self-referential hash embedded in mutable database JSON proves nothing against anyone who can write that JSON, because the hash is simply recomputed after the edit. Only comparison against independently byte-validated artifact content catches it. Both directions are blocked:

- database JSON rewritten (even into internally valid content with a correctly recomputed self-hash) while the artifact bytes are untouched → blocked;
- artifact bytes rewritten (even with the row's `sha256`/`byteCount`/`fullContentSha256` rebuilt to match) while the database JSON is untouched → blocked.

Reducing only one side would prove nothing, so both sides go through `canonicalEvidenceSemantics`.

## Conditional PATCH and CHANGED_FILES requirements

`PATCH` and `CHANGED_FILES` are no longer unconditionally skipped. `checkConditionalEvidenceRequirements` decides from what the Git evidence itself says:

- **no files changed** → an explicit, valid, **empty** `CHANGED_FILES` artifact is still required; absence is never read as emptiness. `PATCH` may be legitimately absent.
- **one or more files changed** → both `CHANGED_FILES` and a `FINAL`-kind `PATCH` are required; every changed file must appear in the changed-file artifact, and must be either covered by the patch or carry an explicit, policy-approved omission reason (today only `SENSITIVE_PATH`).
- conflicting statuses for the same path across the two artifacts, or duplicate normalized paths within one, are rejected.

A `BASELINE`-kind patch is excluded from the authoritative part set, so it can never stand in for a missing final patch.

## Producer truncation blocks critical evidence

`assertProducerTruncationPolicy` blocks an AUTHORITATIVE review whenever the execution writer persisted incomplete `FINAL_GIT`, `PATCH`, `CHANGED_FILES`, or `VERIFICATION` evidence — including truncation *inside* a structurally whole envelope (a cut patch, a cut verification stream). The reviewer never attempts to reconstruct the missing source content; there is no fallback path, only a block. `LOG` follows its explicit optional/truncatable policy.

Provenance is truthful by construction: `producerTruncationSchema` refuses to express "nothing was lost" and "bytes are missing" at the same time, and refuses `producerTruncated: true` with `omittedByteCount === 0`. When an *upstream* capture had already discarded an unknown number of bytes before the producer saw the content, that is reported as a distinct `captureTruncated` flag rather than as an invented omission count — an unknown loss is reported as unknown, and blocks a critical artifact exactly as a known one does.

## Finalization reconstruction

Before a verdict is accepted, `revalidateForVerdict` (inside the same transaction as the terminal-status CAS) re-reads and byte-validates every critical artifact, reconstructs the parsed canonical evidence, re-proves artifact/database semantic equality, rebuilds the immutable validated evidence parts, rebuilds the exact material and byte ledger, and requires equality with what the `ReviewRequest` and the `ReviewInvocation` recorded — `materialBudgetPolicyVersion`, `materialBudgetLedgerHash`, and the invocation's own recorded ledger hash. Any difference becomes `STALE` (or `ERROR` for an artifact-store failure) with **no `ReviewVerdict`**, and Claude is never rerun automatically.

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

`ImmutableReviewCapsule` is exactly the persisted `ReviewInputCapsule` (see above) plus `requestHash`, `reviewInputHash`, and `reviewerConfigHash` (exposed so a reviewer that binds its own material/prompt hash to those components — `claude-cli` — never has to recompute or re-derive them), plus (for FakeReviewer only) its persisted `scenario`, plus (for `claude-cli` only) its persisted, schema-locked `claudeReviewerConfig` — never a workspace path, credential, or live process handle, and never any field assembled outside the capsule. Milestone 2.3B's corrective pass added actual evidence content to `ReviewInputCapsule` itself — bounded/redacted Git diff, changed-file status, verification stdout/stderr, task constraints/acceptance criteria, and an execution artifact manifest — not merely the hashes that were there before; every added field is recomputed fresh from live source-of-truth rows both at request time and at pre-verdict revalidation, exactly like every other capsule field (see `docs/CLAUDE_REVIEWER.md`'s "Review materialization"). Milestone 2.3B registers exactly two reviewers: `fake-reviewer` and `claude-cli`; no API/MCP reviewer code exists.

## ReviewInvocation: one unique, ownership-guarded lifecycle row per request

`ReviewInvocation.reviewRequestId` is `UNIQUE` — exactly zero or one row exists per `ReviewRequest`, database-enforced independently of application logic. `ReviewEngine.createOwnedInvocationOrThrow` creates that single `PREPARING` row atomically: one transaction that re-proves the full ownership predicate (the `ReviewRequest` must currently be `RUNNING` under the exact claiming ownership generation) **and** requires no invocation already exists, together with the insert — if either check fails, no row is inserted and the reviewer is never invoked. `PREPARING` means "claimed, owned process not yet confirmed started"; the instant the reviewer's owned process actually starts, it reports that through `ReviewControls.markInvocationRunning`, and `ReviewEngine.markInvocationRunning` CAS-transitions the row to `RUNNING` (re-proving the invocation id, ownership generation, and an unexpired lease on the owning `ReviewRequest`) and persists the real `processId`/`processIdentity`/`processStartedAt` — a failed transition is treated exactly like a lost heartbeat (the shared `AbortSignal` is aborted, no verdict is ever finalized). The row is then CAS-updated in place (never a second row, and now matching either `PREPARING` or `RUNNING`) as the reviewer (or, for a reviewer like FakeReviewer that never reports anything and so never leaves `PREPARING`, `ReviewEngine` itself as a guarded fallback) records the terminal outcome once known; two triggers back this up at the database level (immutable once terminal; identity/ownership-generation fields can never change on any `UPDATE`). Heartbeat loss — a `false` return **or a thrown error**, both routed through one idempotent ownership-loss guard — aborts the reviewer's own process-running boundary and CAS-updates the invocation to `OWNERSHIP_LOST`; a runtime restart's recovery of a non-terminal review CAS-updates its (sole) invocation to `INTERRUPTED_UNCERTAIN` rather than assuming the process died; and `requestReview` refuses a new non-`fake-reviewer` request for an execution session while any prior invocation for that session is `PREPARING`/`RUNNING`/`INTERRUPTED_UNCERTAIN` — a quarantine that survives even though the stale `ReviewRequest` itself is already terminal. See `docs/CLAUDE_REVIEWER.md`'s "ReviewInvocation lifecycle" for the full design and `packages/relay-v2-reviewer/src/review-invocation-lifecycle.test.ts` for the adversarial coverage (including the database rejecting a second row for the same request, and the reviewer never being called when atomic creation fails).

## Pre-spawn full reconstruction, and engine-owned finalization reconstruction

An AUTHORITATIVE review's binding is rebuilt **from current source-of-truth rows and current artifact bytes** in both of the places that matter, by one shared implementation (`ReviewEngine.reconstructAuthoritativeBinding` + `prepareReviewInvocation`), so "the reconstruction matches" cannot decay into "two separately written code paths happen to agree today".

**Before the process is created.** It was not enough to re-validate the current artifacts and then invoke the reviewer with the *older persisted* capsule: evidence that changed **coherently** after the request was created — artifact bytes and database projection both rewritten to a valid new state, each with correctly recomputed self-hashes — passes every internal-consistency and cross-store check while describing a different run. The only thing that catches it is rebuilding the whole binding and requiring it to reproduce this request's identity. So `runClaimed` now re-reads the session/approval, re-validates the artifact bytes, re-proves artifact/database semantic equality, rebuilds the capsule, recomputes `reviewInputHash`/`requestHash`, rebuilds `ReviewMaterialEnvelopeV1` and its exact ledger, and rebuilds the reviewer's exact prompt and stdin — **then** creates the invocation row. A mismatch is `STALE` with **no `ReviewInvocation` row, no reviewer call, and no process**. Claude is never knowingly run against a binding whose verdict would have to be thrown away afterwards.

**Before the verdict is accepted.** `revalidateForVerdict` runs the same reconstruction inside the finalization transaction and compares it field by field against what the `PREPARING` row committed to (`compareInvocationIdentity`): envelope version, budget policy version, ledger JSON, ledger hash, `reviewMaterialHash`, exact envelope byte count, prompt policy version, `promptHash`, final prompt byte count, `finalStdinHash`, and final stdin byte count. It then requires the reviewer's echoed `reviewedMaterialHash`/`reviewedPromptHash` to match the **independent reconstruction**, not merely what the reviewer was handed — a reviewer that echoes its own input back proves only that it can copy. Nothing here relies on a check `ClaudeCliReviewer` already performed: the reviewer is the party whose output is being judged.

Outcomes are split deliberately, and none of them reruns anything:

| Condition | Status | `failureCode` |
| --- | --- | --- |
| Current evidence no longer reproduces the request identity | `STALE` | `EVIDENCE_CHANGED` |
| Artifact store unavailable/unreadable | `ERROR` | `ARTIFACT_STORE_UNAVAILABLE` / `ARTIFACT_STORE_READ_FAILURE` |
| Persisted immutable input binding corrupted | `ERROR` | `REVIEW_IMMUTABLE_INPUT_MISMATCH` |
| Reconstruction disagrees with the bound invocation identity | `ERROR` | `INVOCATION_BINDING_MISMATCH` |
| Reviewer echoed hashes that do not match the reconstruction | `ERROR` | `REVIEWER_ECHO_MISMATCH` |

`STALE` means the world moved, which is not an error. Everything else describes a malformed or impossible authority state and is `ERROR` (no `invalidatedAt`), never filed away as ordinary drift.

## Runner-level verification output loss blocks an AUTHORITATIVE review

`checkVerificationCaptureCompleteness` refuses any AUTHORITATIVE review whose verification evidence carries a `TRUNCATED_UNKNOWN` stream capture, or whose result claims discarded runner output while both streams claim complete capture. **A PASS never overrides missing evidence:** "the command exited 0" and "here is what the command said" are different claims, and a review that cannot see the second is not reviewing the run, it is trusting an exit code. A *known*, fully described truncation of output this runtime held in full does not block — it is disclosed exactly, with the complete stream's hash. See `docs/EXECUTION_ENGINE.md` for how the provenance is produced.

## Milestone 2.3B migration: enforceable foreign-key check

The 2.3B migration rebuilds `ReviewRequest` and adds `ReviewerCapabilitySnapshot`/`ReviewInvocation` inside one explicit `BEGIN`/`COMMIT` (sqlite.org's documented 12-step table-rebuild procedure), with `PRAGMA foreign_keys=OFF/ON` outside the transaction as required. A bare `PRAGMA foreign_key_check;` only ever returns a result set describing violations — it is a no-op with respect to script/transaction control and can never by itself abort a script or a `COMMIT`. The migration instead routes the violation count through a real SQLite `CHECK` constraint: a temp table whose single column is constrained to always equal zero, fed from `pragma_foreign_key_check()` (the table-valued function form of the same pragma). Zero violations inserts cleanly; one or more raises a constraint failure that prevents `COMMIT` and rolls back the entire rebuild. Verified through the real `prisma migrate deploy` path (not string inspection, and never by modifying the migration script itself) by `migration-path.test.ts`'s "a real dangling foreign key seeded directly in an unmodified 2.3A database ..." test: it deploys the unchanged, checked-in migrations through 2.3A, disables foreign keys on that one setup connection to seed a genuine orphan `ReviewRequest` row (representable in the unmodified 2.3A schema, referencing a real project/task but a nonexistent `executionSessionId`), closes that connection, then runs the unchanged, checked-in 2.3B migration and confirms it fails specifically at the FK guard and the original schema/data/indexes/triggers survive untouched, `PRAGMA foreign_keys` is back on for a fresh connection, and Prisma's migration history does not mark 2.3B successful. Since `ReviewRequest` rows can never be deleted or have `executionSessionId` changed (the two triggers above), the orphan is "corrected" by creating the missing `ExecutionSession` row it always referenced, not by editing the orphan row itself — after which the unchanged migration is re-run and succeeds. A separate, generic rollback test (corrupting a copy of the migration to force a mid-rebuild `NOT NULL` violation) is retained alongside this one to cover rollback behavior for a defect class the FK guard does not itself catch.

## Structured verdict validation

`StructuredReviewVerdict` is Zod-validated with `.strict()` (unknown fields are rejected, not silently granted authority) and cross-field invariants:

- `APPROVE` cannot contain a blocking `BLOCKER` or `HIGH` finding.
- `REJECT` must contain at least one blocking finding.
- `NEEDS_CHANGES` must contain at least one required action.

A reviewer's free-form summary text carries no authority over the verdict. Any structurally invalid reviewer response — including a deliberately malformed one — becomes `ERROR`, never `APPROVE`.

## Eligibility

A review may be requested only when: the execution session belongs to the requesting project; the execution session reached `SUCCEEDED` and the task reached `AWAITING_USER_ACCEPTANCE`; the workspace lease is released; baseline/final Git evidence and verification results pass strict, fail-closed schema validation (`checkGitEvidenceIntegrity`/`checkVerificationEvidenceIntegrity` in `relay-v2-reviewer/src/review-binding.ts` — malformed non-empty evidence, an unrecognized shape, a duplicate/conflicting changed path, a traversal path, a tampered self-referential hash, or PASS with a nonzero exit code are all hard failures here, never silently degraded to "unavailable"); the execution capsule and baseline/final Git evidence exist for Codex sessions; verification results exist whenever verification operations were approved; at least one execution artifact was recorded; the approval snapshot used for the execution can still be located; and reviewer authority resolves to `AUTHORITATIVE` or `DIAGNOSTIC` per the rules above (never for reviewer selection `NONE`, never for a reviewer that does not match the approved selection). This same eligibility check runs again, unchanged, inside `revalidateForVerdict` immediately before a verdict is accepted — so evidence that changed or was invalidated after the request was created is caught before finalization too. A `FAILED`, `CANCELLED`, `TIMED_OUT`, `BLOCKED`, or still-running execution structurally cannot reach `AWAITING_USER_ACCEPTANCE`, so it can never receive any verdict — including `APPROVE` — through this path.

**Artifact-store requirement is a separate, mandatory gate for AUTHORITATIVE reviews (Milestone 2.3B fourth corrective pass).** `ReviewEngine.validateAuthoritativeArtifactEvidence` — keyed on the *resolved* `reviewAuthority`, not the executor id — requires a configured, readable `artifactsRoot` and full byte-level validation (`relay-v2-reviewer/src/artifact-evidence.ts`: ownership, bound-set membership, canonical path containment with no traversal/symlink escape, byte count, SHA-256, never the live project/Relay workspace) of every artifact type an AUTHORITATIVE review needs (`LOG`, `FINAL_GIT`, and `VERIFICATION` when verification was approved) whenever `reviewAuthority === "AUTHORITATIVE"` — never merely "when this engine happens to have `artifactsRoot` set," which was the pre-fourth-pass behavior (a bare `if` that silently skipped validation instead of asserting the requirement). This is checked at three points: `requestReview` (before any `ReviewRequest` row exists), a live pre-spawn re-check inside `runClaimed` (immediately before the `ReviewInvocation` row is created and the reviewer is ever invoked — catches a store that becomes unreadable after the request but before the run), and `revalidateForVerdict`. Absence or a read/hash failure is always `ERROR` (`failureCode: "ARTIFACT_STORE_UNAVAILABLE"`/`"ARTIFACT_STORE_READ_FAILURE"`), never `STALE` — see `docs/CLAUDE_REVIEWER.md`'s "A fourth independent corrective pass" for the full design and rationale. A DIAGNOSTIC review has no such requirement.

**Material budget and truncation policy (also Milestone 2.3B fourth corrective pass).** For an AUTHORITATIVE review only, `checkAuthoritativeMaterialPolicy` (`relay-v2-reviewer/src/review-binding.ts`) additionally requires: a truncated final Git diff still evidences every changed file; a **failed** verification operation's truncated stdout/stderr is rejected outright (the failure-relevant tail cannot be proven preserved by the upstream head-only truncation); a critical free-text field (spec objective, execution summary, constraints, acceptance criteria) has not collapsed to near-nothing under secret redaction; and the full assembled capsule fits within `AUTHORITATIVE_REVIEW_MATERIAL_BUDGET`'s aggregate and per-category byte limits. Checked at the same two points as the artifact-store gate (`requestReview`, before any row exists; `revalidateForVerdict`, before verdict acceptance) — never for DIAGNOSTIC. See `docs/CLAUDE_REVIEWER.md`'s "Central material byte budget enforcement" for the full budget shape and enforcement points.

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

`/v2/reviews/{id}` shows the linked execution/task/project, reviewer id and **authority** (`AUTHORITATIVE` for a `claude-cli` review of a task approved for `CLAUDE`; `DIAGNOSTIC` for every FakeReviewer review), reviewed evidence hashes, verification summary, final Git branch/HEAD identity, the review event timeline, the structured verdict with findings grouped by severity and required actions, a stale banner when applicable, and a **Cancel Review** action while non-terminal. The status pill itself reads `Diagnostic approval` (not `APPROVED`) whenever the verdict is a `DIAGNOSTIC` approve, alongside the separate authority pill and an explicit "DIAGNOSTIC review... can never satisfy a future auto-commit or acceptance gate" note — no API response or UI surface ever collapses a diagnostic verdict back to a plain, unqualified status string. No commit, push, merge, retry, or deployment control exists anywhere in this UI, and the page states that approval does not commit or merge and that the execution still requires later user acceptance or an auto-commit policy.

## Planned

- **Milestone 2.4**: an auto-commit gate that can act on an `APPROVED` review — not present yet. Today an `APPROVED` verdict changes only the `reviewGateProjection`; the execution still requires separate user acceptance, `commitAuthorityEligible` remains `false`, and a `DIAGNOSTIC` verdict (and, per Milestone 2.3B, an `AUTHORITATIVE` verdict too) can never satisfy that gate regardless of milestone.
