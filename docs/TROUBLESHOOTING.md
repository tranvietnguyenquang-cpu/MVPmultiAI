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

## Claude CLI is not found

Open the Claude diagnostics panel on a Claude-approved execution's Review Gate and choose **Refresh diagnostics**. Relay checks an explicit `RELAY_V2_CLAUDE_PATH`, then `claude.exe`/`claude` directly on `PATH`, then (Windows only) statically parses — never executes — a `claude.cmd`/`claude.ps1` npm shim on `PATH` to recover the real native binary it references. The resolved candidate — including an `RELAY_V2_CLAUDE_PATH` override, which does not get a pass — must be a canonical absolute regular file named exactly `claude.exe`/`claude`, non-empty, and (on Windows) a structurally valid native PE image; a `.cmd`/`.ps1`/`.sh`/`.js` file, a directory, an unexpected basename, or a malformed/non-PE `.exe` is rejected before Relay ever considers it, regardless of how it was pointed to. Relay never falls back to running a `.cmd`/`.ps1` shim with shell interpretation.

## Claude CLI is installed but unavailable

Run `claude auth status` in your normal user terminal. Relay relies on subscription (`claude.ai`) CLI authentication and never uses, stores, or accepts an `ANTHROPIC_API_KEY` — `SafeProcessRunner`'s environment allowlist strips it (and every other provider-shaped credential variable) before the process is ever spawned, even if present in your shell. Authentication status is a time-stamped diagnostic, refreshed live immediately before every review (never trusted from a stale cached snapshot alone), and can change between checks. An authenticated diagnostic still does not prove that any review actually ran.

## A Claude review became ERROR or STALE instead of a verdict

This is by design, not a bug to work around: a structurally invalid response, a `reviewedRequestHash`/`reviewedMaterialHash`/`reviewedPromptHash` mismatch, a nonzero exit, a timeout, an unexpectedly mutated disposable review bundle, or evidence that changed after the review was requested all become `ERROR`/`STALE`, never a fabricated `APPROVE`. There is no retry in Milestone 2.3B — request a new review. If the local Claude CLI's executable identity, version, *capability set* (a `--help` output change without a version bump, a missing/UNKNOWN required flag), or **wrapper contract/parser version** (a deployment remapping the same CLI version string to a different verified transport contract) changed since the review was requested, the review is rejected for the same reason; refresh diagnostics and request a new review.

Persisted Git/verification evidence that fails strict schema validation, or an execution artifact (log, final Git evidence, verification results) that no longer byte-matches its own recorded hash/size or resolves outside the artifact store, also blocks the review with a specific reason rather than proceeding on stale or tampered evidence — see `docs/REVIEW_ENGINE.md`'s "Eligibility" and `docs/CLAUDE_REVIEWER.md`'s "Known limitations". A heartbeat that fails **or throws** during an in-flight Claude invocation aborts the owned process and marks the invocation `OWNERSHIP_LOST`; no verdict is ever recorded for that attempt.

A specific case of "structurally invalid response": the CLI's actual transport wrapper (`type`/`subtype`/`is_error`/`api_error_status`/`result`/`structured_output`/`permission_denials`) no longer matches the currently supported, verified shape (`claude.exe` v2.1.220 and v2.1.221, which share one verified contract — see `docs/CLAUDE_REVIEWER.md`'s "Registered versions, and what registration means"), or its `result` and `structured_output` fields disagree on the verdict. Both become `ERROR`, never an `APPROVE` recovered by trusting one field over the other or by guessing at a newer shape. If this happens after a genuine CLI update, use the opt-in real smoke's diagnostic mode (`RELAY_V2_CLAUDE_SMOKE_DIAGNOSTIC=1`, see `docs/SMOKE_TEST.md`) to capture the new shape and update the parser from verified fact.

If a Relay restart interrupts an in-flight Claude invocation, its execution session is quarantined (a new authoritative review request is refused with a "quarantined" error) until that invocation's uncertain outcome is resolved — Relay never assumes the prior process actually terminated just because the runtime process did. There is no manual "clear the quarantine" action in this milestone; it exists to make interrupted-invocation risk visible, not to auto-resolve it.

## A Claude review request was rejected: "no execution-artifact storage root configured"

An AUTHORITATIVE review (a `codex-cli` execution approved for reviewer `CLAUDE`) always requires a configured, readable, byte-validated execution-artifact store — this is a mandatory assertion, not an optional check. Production always configures it; seeing this error means either a non-standard runtime configuration is missing `artifactsRoot`, or (a distinct message, "...exceeds the per-artifact size limit" / "...byte count does not match its persisted metadata" / "...content hash does not match its persisted metadata") the artifact store is present but a required artifact (the execution log, final Git evidence, or verification results) failed byte/hash validation against what was recorded at execution time — which always ends the review as `ERROR`, never `STALE`, since this is a configuration/integrity problem, not ordinary evidence drift. Neither case ever spawns the Claude CLI. Request a new review only after confirming the artifact store is configured and the underlying files are intact; this is not something a retry alone resolves. See `docs/CLAUDE_REVIEWER.md`'s "A fourth independent corrective pass".

## A Claude review request was rejected for exceeding the material budget, or blocked by the truncation policy

An AUTHORITATIVE review's total evidence (task spec, Git diff, changed-file list, verification stdout/stderr, execution log, artifact manifest) must fit within `AUTHORITATIVE_REVIEW_MATERIAL_BUDGET`'s aggregate and per-category byte limits, and specific evidence categories have additional safety requirements beyond fitting the byte budget: a truncated final Git diff must still evidence every changed file; a **failed** verification operation's stdout/stderr must not have been truncated (the failure-relevant tail cannot be proven preserved); and a critical field (approved spec, execution summary, constraints, acceptance criteria) must not have collapsed to near-nothing under secret redaction. Any of these rejects the request before any `ReviewRequest` row is created — the Claude CLI never spawns. This is not retryable by simply requesting again with identical evidence; it reflects the underlying execution's evidence genuinely being too large or unsafe to review as bounded. Byte accounting is exact (the real serializer over the real rendered values, framing and escaping included), and `maxPromptBytes`/`maxFinalStdinBytes` are enforced independently — a prompt one byte over its own ceiling is rejected even while still under the stdin ceiling. See `docs/CLAUDE_REVIEWER.md`'s "Exact serialized material byte ledger" and "Exact prompt and stdin accounting".

## A Claude review was rejected: "output that cannot be proven complete"

A verification operation's output was discarded at the process-runner boundary before Relay could record it — the process wrote more than the combined output cap, so some of it was never forwarded. The exit code is still recorded, but a passing exit code does **not** substitute for the output itself: "the command exited 0" and "here is what the command said" are different claims, and a review that cannot see the second is trusting an exit code rather than reviewing the run. The request is refused before any `ReviewRequest` row exists and the Claude CLI never spawns.

This is not retryable with the same evidence. Re-run the execution with less verification output (or a quieter test reporter) so the complete streams fit. A *known*, fully described truncation of output Relay did hold in full is fine and does not block — only unattributable/unrecoverable loss does. See `docs/EXECUTION_ENGINE.md`'s "Runner-boundary output loss is propagated, never discarded".

## A Claude review became ERROR with "INVOCATION_BINDING_MISMATCH" or "REVIEWER_ECHO_MISMATCH"

Before accepting any verdict, the engine independently rebuilds the material envelope, its byte ledger, the prompt, and the stdin from current evidence and compares them field by field against the identity the `PREPARING` invocation row committed to before the process started, then requires Claude's echoed material/prompt hashes to match that reconstruction (not merely what it was handed).

- `INVOCATION_BINDING_MISMATCH` — the reconstruction disagrees with the bound invocation identity (which field is named in the failure message).
- `REVIEWER_ECHO_MISMATCH` — the reviewer echoed hashes that do not match the reconstruction.

Both are `ERROR`, never `STALE`: nothing about the world changed, so this is a malformed or impossible authority state, not ordinary evidence drift. No verdict is recorded and nothing is rerun. If evidence genuinely changed instead, you will see `STALE` with `EVIDENCE_CHANGED` — and, since the pre-spawn reconstruction now catches coherent drift before the process starts, usually with no invocation row at all. Request a new review.

## A Claude review was rejected: "the log is malformed or was cut mid-record"

The execution `LOG` artifact is newline-delimited JSON, and every included record must be a complete, schema-valid JSON object. A partial trailing line, a JSON array, a bare scalar, or an unrecognized record shape blocks the review rather than being embedded into the review material as if it were a trustworthy transcript. Relay's own writer never produces this (it writes a record whole or omits it whole), so this indicates the artifact was written by something else or edited after the fact. Re-run the execution; there is no way to repair a log whose records cannot be accounted for.

## A Claude review was rejected: "the artifact store and the database have diverged"

The evidence artifact bytes and the persisted database JSON no longer describe the same change set, diff, or verification results. An AUTHORITATIVE review renders from artifact bytes and requires the database projection to reduce to exactly the same canonical semantics, so either store being edited independently blocks the review before any reviewer runs.

This is expected if you edited `.relay-data/artifacts/executions/<session-id>/*` by hand, or wrote to `ExecutionSession.finalEvidenceJson`/`verificationResultsJson` directly. Re-run the execution to produce a fresh, mutually consistent evidence set; there is no way to force a review past this check, and none is wanted.

## A Claude review was rejected: "the execution writer persisted incomplete ... evidence"

The execution could not persist a critical artifact (`FINAL_GIT`, `PATCH`, `CHANGED_FILES`, or `VERIFICATION`) in full — usually because a diff or verification stream exceeded the writer's own cap. An AUTHORITATIVE review will not proceed on partial critical evidence and will not attempt to reconstruct the missing content.

Reduce what the run produces (a smaller change set, or verification that emits less output) and re-run. A producer-truncated `LOG` does **not** block; it is disclosed and the review continues.

## A Claude review was rejected: "a final patch artifact is required" or "a changed-file artifact is required"

The final Git evidence records changed files, but the run did not persist a covering patch or a changed-file artifact — or it recorded no changed-file artifact at all. Absence is never interpreted as "nothing changed": a run that touched nothing still writes an explicit, valid, **empty** changed-file artifact.

This normally means the session predates Milestone 2.3B's fifth corrective pass, or its artifacts were deleted. Re-run the execution.

## A Claude review was rejected for a decoding or encoding reason

Strict UTF-8 decoding refused the artifact bytes: invalid UTF-8, a NUL byte, a disallowed control byte, binary content, or a leading byte-order mark. Authoritative evidence is never decoded permissively, because a silent U+FFFD substitution both corrupts the evidence and makes the rendered size disagree with the bytes that were hashed.

Check whether an editor or an external tool rewrote the artifact file (BOMs are a common cause on Windows). Re-run the execution to regenerate it.

## Claude review button is missing

The Claude review action only appears when the task's *currently approved* reviewer selection is `CLAUDE`. Changing a task's reviewer selection after approval invalidates the previous approval (a new approval is required) — this mirrors how changing executor/model/effort already invalidates approval. FakeReviewer's diagnostic controls remain available regardless of reviewer selection; they can never produce an AUTHORITATIVE verdict.
