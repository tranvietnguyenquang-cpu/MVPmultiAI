# Relay v2 execution engine

Status: **implemented and tested through Milestone 2.2**. FakeExecutor remains the deterministic diagnostic executor; `CodexCliExecutor` is the only real local CLI executor. Claude is not an executor — as of Milestone 2.3B it is a real, read-only reviewer only (see `docs/REVIEW_ENGINE.md` and `docs/CLAUDE_REVIEWER.md`). No API provider is implemented for either execution or review.

## Lifecycle

The only supported path is:

```text
Approved Task -> ExecutionEngine -> RelayExecutor -> validated ExecutionOutcome
```

`ExecutionSession` is a mutable state-machine aggregate. `ExecutionEvent` is its append-only chronological history and the source of truth for SSE. `AuditEvent` records security and authority decisions; it does not duplicate ordinary lifecycle events.

Session transitions:

```text
QUEUED -> WAITING_FOR_WORKSPACE | CLAIMED | CANCELLED | BLOCKED
WAITING_FOR_WORKSPACE -> CLAIMED | CANCELLED | BLOCKED
CLAIMED -> PREPARING | CANCELLATION_REQUESTED | FAILED | BLOCKED
PREPARING -> RUNNING | CANCELLATION_REQUESTED | FAILED | TIMED_OUT | BLOCKED
RUNNING -> CANCELLATION_REQUESTED | SUCCEEDED | FAILED | TIMED_OUT | BLOCKED
CANCELLATION_REQUESTED -> CANCELLED | TIMED_OUT | BLOCKED
SUCCEEDED | FAILED | TIMED_OUT | CANCELLED | BLOCKED -> terminal
```

Only `ExecutionEngine` changes execution lifecycle state. Invalid application-service transitions are rejected and audited.

## Approval authority

Before creating `QUEUED`, the engine checks task status, the approved approval record, specification hash, approved snapshot, executor/model/effort/reviewer, canonical permissions hash, project identity, canonical Git-root workspace, and absence of another active task execution. A stale approved value invalidates the approval and returns the task to `PENDING_APPROVAL`; the engine never manufactures replacement approval.

The FakeExecutor descriptor is non-writing. Its `executorId` is `fake`. Codex uses `codex-cli` and additionally requires approved workspace-write, non-production confirmation, timeout, verification catalog, and dirty-workspace policy. Changing any approved field invalidates authority.

## Codex execution capsule and Git evidence

Before queueing Codex, the engine captures a stable Git baseline and builds a sanitized, hashed execution capsule containing only the approved task, policy, workspace identity, Git branch/HEAD/status, timeout, and server-owned verification operations. Task prose is transported through stdin, never argv. `.env` contents, credentials, private keys, dumps, unrelated files, and conversation history are excluded.

Write-capable Codex is blocked on a dirty workspace by default. A non-critical task may proceed only when `ALLOW_DIRTY_WORKSPACE` was approved and the request acknowledges the exact stable baseline hash. Critical tasks require a clean workspace. Relay never stashes, resets, checks out, stages, commits, pushes, merges, or discards changes.

The baseline also protects existing work with content hashes, index object identity, staged/unstaged/untracked path sets, and stash-ref/list identity. Final evidence separately reports destroyed changes, hidden staging/worktree state, changed stash identity, unaccounted paths, and HEAD/branch movement. Any such signal blocks an otherwise successful Codex run. This is strong evidence-based detection, not a claim that every possible Git/filesystem concealment technique can be identified.

Post-run evidence captures branch, HEAD, status, content hashes, binary metadata, staged/unstaged/untracked state, bounded patch evidence, and a baseline-to-final delta. Pre-existing paths are marked separately from session-created changes. A branch or HEAD mutation blocks an otherwise successful run.

## Durable claims and leases

Queued sessions live in SQLite and survive process restart. Claiming uses a transaction, conditional status update, random lease token, and partial unique indexes. Only one unreleased lease may exist for a canonical workspace or session. Contenders enter `WAITING_FOR_WORKSPACE`. Heartbeats renew only the exact session/token lease.

Expired ownership is recovered only after both lease expiry and stale heartbeat checks. The session is conservatively marked `BLOCKED`, the lease is released, and execution plus security audit events are written. There is no ordinary force-unlock endpoint.

## FakeExecutor

Implemented deterministic scenarios: success, failure, timeout, cancellation, event count/delay, warnings, simulated changed-file metadata, and summary. Delay behavior is injected through execution controls, and unit tests use fast timing. FakeExecutor does not read or alter project files, use Git, launch commands, or contact a network service.

## Output and artifacts

Output is redacted before SQLite, SSE, or artifact persistence. SQLite stores bounded previews. Full bounded NDJSON logs and simulated changed-file JSON live below:

```text
<Relay data>/artifacts/executions/<session-id>/
```

Artifact rows contain relative path, SHA-256, byte count, truncation status, and — since Milestone 2.3B's fifth corrective pass — truthful producer-truncation provenance (`schemaVersion`, `fullContentSha256`, `originalByteCount`, `omittedByteCount`, `truncationMethod`; see below). Artifacts are app-owned and outside project workspaces. Milestone 2 performs no automatic artifact deletion.

## Canonical, versioned evidence artifacts

Every evidence artifact this engine writes conforms to a strict, versioned schema shared with the reviewer (`packages/relay-v2-domain/src/evidence-artifacts.ts`, `EVIDENCE_ARTIFACT_SCHEMA_VERSION = "evidence-artifact-v1"`). `evidence-envelopes.ts` renders the engine's in-memory evidence into those envelopes, and **one in-memory value drives both the artifact bytes and the database projection** of the same evidence — so the reviewer's later canonical-equality check between the two is a real check on storage integrity rather than a comparison of two independently assembled shapes.

| File | Type | Written when |
| --- | --- | --- |
| `final-git.json` | `FINAL_GIT` | after every codex-cli run, from the post-run capture and delta |
| `final-patch.json` | `PATCH` (`FINAL`) | whenever anything changed, or a diff exists |
| `baseline-patch.json` | `PATCH` (`BASELINE`) | at request time when the workspace started dirty |
| `changed-files.json` | `CHANGED_FILES` | always, **including for a run that changed nothing** |
| `verification-results.json` | `VERIFICATION` | when verification operations were approved |
| `output.ndjson` | `LOG` | always |

An empty change set is written as an explicit, valid, empty `CHANGED_FILES` artifact rather than by omitting the artifact: a reviewer must be able to tell *"this run touched nothing"* apart from *"nobody recorded what this run touched"*. An executor that produces no Git evidence at all (a diagnostic `FakeExecutor` session) records only the paths it **reports** touching, with null content hashes marking the claim as unproven; an AUTHORITATIVE review can never mistake that for a Git-backed change set, because it additionally requires the set to agree with the final Git evidence.

## Truthful producer truncation provenance

`ArtifactMetadata` now carries, alongside the `sha256`/`byteCount` of the bytes actually on disk:

- `schemaVersion` — the versioned contract the content conforms to;
- `fullContentSha256` — the hash of the **complete** content, before any truncation;
- `originalByteCount`, `omittedByteCount`, `truncationMethod`.

Every count is computed **before** the cut, from the complete content the writer held — never back-inferred from the already-shortened result, and never reported as `originalByteCount === includedByteCount, omittedByteCount === 0` when content was in fact lost.

- **Structured evidence is never byte-truncated.** A truncated JSON document does not parse, so cutting it would replace usable evidence with unusable bytes while still occupying the artifact slot. Truncation that genuinely occurred is carried *inside* the envelope, on the specific field it affected.
- **`WorkspaceEvidenceService`** measures and hashes the complete redacted diff before bounding it, and records the result in `GitEvidence.patchProvenance`. When the bounded process read had already discarded an unknown number of bytes upstream, that is reported as `captureTruncated` rather than guessed at.
- **`VerificationCatalogRunner`** does the same per stream (`stdoutProvenance`/`stderrProvenance`), and now bounds `HEAD_AND_TAIL` rather than head-only, so a failed operation's failure-relevant tail survives truncation instead of being the first thing discarded.
- **`ExecutionArtifactStore.appendLog`** accumulates every byte *offered* to the log — including bytes the cap refused to store — so `finalizeLog` reports the complete original size and hash rather than describing the truncated file as if it were whole.

### Runner-boundary output loss is propagated, never discarded

`SafeProcessRunner` counts every byte a process writes but stops **forwarding** chunks once the combined output cap is reached, reporting `outputTruncated`/`stdoutBytes`/`stderrBytes` on its exit event. A consumer that read only `exitCode` from that event — which `VerificationCatalogRunner` previously did — would persist an *empty* captured stream, `captureTruncated: false`, and status `PASSED` for an operation whose output was thrown away: an evidence record asserting that a command which printed megabytes printed nothing.

Every verification result now carries the runner's own figures (`runnerOutputTruncated`, `runnerStdoutBytes`, `runnerStderrBytes`) plus per-stream `StreamCaptureProvenance` (`packages/relay-v2-domain/src/stream-capture.ts`), whose accounting closes end to end:

```
rawByteCount  −upstreamOmitted→  deliveredByteCount
              −redactionOmitted→ capturedByteCount
              −truncationOmitted→ includedByteCount
```

`captureCompleteness` is one of:

- **`COMPLETE`** — every byte the process wrote reached this runtime, and every byte held is rendered.
- **`TRUNCATED_KNOWN`** — this runtime held the complete stream and deliberately rendered less of it; the omitted amount and the complete content's hash are both known.
- **`TRUNCATED_UNKNOWN`** — output was lost upstream, or an upstream loss cannot be attributed to a single stream. The complete content no longer exists anywhere, so `fullStreamContentHash` is `null` rather than fabricated from the surviving fragment.

`SafeProcessRunner` now reports each chunk's original `rawByteCount`, which lets a consumer tell redaction apart from discarded output exactly; a runner that does not report it leaves the split genuinely unknowable, and that is recorded as `TRUNCATED_UNKNOWN` rather than resolved in the evidence's favour. An empty capture with nonzero raw bytes can only be `LOST_UPSTREAM` or `REDACTED_EMPTY` — never `LEGITIMATE_EMPTY`. A `PASSED` exit code never overrides any of this: the schema refuses to record "the runner discarded output" alongside two streams both claiming complete capture, and an AUTHORITATIVE review refuses `TRUNCATED_UNKNOWN` outright (see `docs/REVIEW_ENGINE.md`).

### The execution LOG is record-structured, not a byte blob

`appendLog` writes one **complete** NDJSON record or none at all. The byte cap used to store whatever prefix of a record happened to fit, leaving a final line that is half a JSON object — which a consumer had to either reject wholesale or, worse, embed as a transcript, showing a reviewer a fragment of an event as if it were the event. A record is now atomic: it fits and is written whole, or it is omitted whole and counted as omitted, so the file always ends on a record boundary.

`finalizeLog` returns a versioned `LogProvenance` (`log-records.ts`), persisted verbatim in `ExecutionArtifact.provenanceJson` and carried unchanged to the reviewer: `originalRawByteCount`/`includedRawByteCount`/`omittedRawByteCount`, `fullRawContentHash` (the **complete** producer stream, not the capped preview), `includedContentHash`, `producerTruncated`, `truncationMethod`, `captureCompleteness`, `recordCountOriginal` (nullable — never invented), and `recordCountIncluded`.

Truncation everywhere cuts only on complete Unicode code-point boundaries (`boundTextToBytes`), never an arbitrary `Buffer` slice that can split a multibyte sequence, and the inserted omission marker is counted toward the stored bytes rather than smuggled in on top of the cap.

## SSE

`GET /api/v2/executions/{id}/events` checks loopback access and project/session ownership. It reads persisted events by monotonic sequence, prefers reconnect `Last-Event-ID` over the initial `cursor`, avoids duplicates, polls bounded batches, and closes after terminal events are drained. The bounded server connection lifetime and polling interval are configurable for tests.

The browser keeps one native `EventSource` open and permits its automatic reconnect after a nonterminal bounded close or temporary network error. A stable sequence cursor deduplicates rendered events. Repeated failures show a non-blocking reconnecting message; terminal completion and component unmount close the source. A disconnect loses no event because persisted `ExecutionEvent` rows, not memory, are the source of truth.

## Runtime-host diagnostics

Every scheduled runtime tick has a top-level error boundary. Unexpected claim, recovery, or owned-session errors produce a bounded, secret-redacted structured diagnostic with a session ID when ownership is known. Diagnostics omit stack traces, retain only the latest 50 entries in process memory, are exposed through runtime status and an optional callback, and cannot stop the polling loop. Session lifecycle remains owned by `ExecutionEngine`; uncertain abandoned ownership is handled by durable stale recovery.

## Implemented UI

- `/v2/executions`: sessions, runtime/FakeExecutor health, and lease history.
- `/v2/executions/{id}`: live events, timeline, approved metadata, lease state, result, artifacts, and cancellation.
- Approved task detail: explicit FakeExecutor scenario and separate **Request Execution** action.

Execution cancellation requires the owning `projectId` and returns the same not-found response for absent and wrong-project sessions before invoking the engine.

## Local process and verification boundary

Only `SafeProcessRunner` imports `node:child_process`. It validates absolute executable and working-directory paths, uses argv arrays and `shell: false`, passes an allowlisted environment, records exact PID/start identity, streams redacted output, bounds artifacts, and owns cancellation/timeout. On Windows, process-tree termination targets only the owned PID with argument-array `taskkill.exe`.

Abort observation begins before asynchronous validation and is rechecked before and immediately after spawn. After ownership exists, cancellation/timeout converges on one termination promise. The executor stream cannot finish normally until actual child exit, so `ExecutionEngine` cannot finalize or release the lease while the process remains owned.

The server-owned verification catalog currently supports `npm test`, `npm run typecheck`, and `npm run build` through Node plus npm's CLI entry point—never an arbitrary task-supplied shell string. Exit zero without passing the approved verification list is `FAILED`, not accepted success.

## Review gate (Milestone 2.3A/2.3B)

A `SUCCEEDED` session with its task at `AWAITING_USER_ACCEPTANCE` may request an evidence-bound review through `ReviewEngine` (see `docs/REVIEW_ENGINE.md`). A review verdict never changes `ExecutionSession` or `Task` status — it only sets a separately computed, authority-preserving `ReviewGateProjection` (never a plain status string; `commitAuthorityEligible` is always `false` in this milestone). `AWAITING_USER_ACCEPTANCE` still means what it always meant: the execution result requires later user acceptance.

Requesting a review never runs a reviewer inline: the API only creates a `PENDING` `ReviewRequest` row, and a separate `ReviewRuntimeHost` durably claims and runs it (mirroring this engine's own `ExecutionRuntimeHost` claim/lease/heartbeat/recovery design). Reviewer authority is matched against the task's approved reviewer selection independently of executor selection — see "Reviewer authority" in `docs/REVIEW_ENGINE.md`.

## Planned

Real Claude CLI review is implemented (Milestone 2.3B; see `docs/REVIEW_ENGINE.md` and `docs/CLAUDE_REVIEWER.md`). An auto-commit gate that can act on an approved review (Milestone 2.4) remains a later, separately approved milestone. Automatic commit, merge, push, deployment, MCP, and API providers remain planned.
