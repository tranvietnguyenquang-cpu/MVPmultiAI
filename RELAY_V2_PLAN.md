# Relay v2 Repository Audit and Migration Plan

Status: Milestone 0 audit only

Audit date: 2026-08-01

Repository: `C:\mvpmultiai`

Baseline branch: `main`

Baseline commit: `f5a2299164401f14321e73de8e73403c712aeed7` (`feat: add per-execution model selection`)

Application changes in this milestone: none

## 1. Executive summary

The repository is not a prototype that should be rewritten. It is an established TypeScript monorepo with a Next.js UI/API, a native Node.js worker, Prisma/PostgreSQL persistence, Redis/BullMQ dispatch, local Codex and Claude CLI adapters, Git and command evidence capture, persisted execution events, Server-Sent Events (SSE), project memory files, and a meaningful automated test suite.

The safest Relay v2 path is an evolutionary migration that keeps the TypeScript, React/Next.js, Node.js, Prisma, Zod, Vitest, and Playwright stack while reorganizing the existing packages around an explicit task/approval/orchestration domain. The strongest current components—workspace containment, shell-free argument-array spawning, Windows process ownership, provider stream parsing, cancellation, timeout handling, Git evidence, local-only HTTP boundaries, and durable event delivery—should be adapted, not replaced.

The largest mismatch is infrastructure and workflow:

- The current app requires PostgreSQL, Redis, BullMQ, Docker, and a separate native worker. Relay v2 should use SQLite as its local source of truth and remove Redis/BullMQ from the required runtime.
- The current product is partly conversation-first and can queue an implementation directly from a conversation message. Relay v2 must be task-first: every imported or externally created task starts as `PENDING_APPROVAL` and task creation never starts execution.
- Task states, approvals, runs, reviews, issues, memory, provider configuration, and audit records do not yet match the Relay v2 lifecycle or data contract.
- CLI commands and model names are currently encoded in source. Relay v2 must inspect each installed CLI's version/help output, persist a capability snapshot, and reject unsupported model/effort options rather than guessing.
- Current memory updates write Markdown immediately. Relay v2 must keep the database authoritative and generate reviewable Markdown views only from accepted, attributable records.

Recommended migration shape:

1. Keep the current implementation recoverable and initially introduce v2 modules beside it.
2. Create a new SQLite database rather than mutating or deleting the PostgreSQL data.
3. Preserve the native runtime process, but replace Redis/BullMQ with a SQLite-backed durable work claim loop and workspace leases.
4. Put every state change behind one orchestrator service and one validated transition map.
5. Cut over screen-by-screen behind a local feature flag after each milestone's tests and user approval.
6. Retain legacy data and routes read-only until a migration report proves row counts, identifiers, relationships, and artifact checksums.

No test suite was rerun for this documentation-only milestone. The ignored `artifacts/verification/latest.md` report says typecheck, lint, unit, integration, e2e-contract, and build passed previously, but this audit did not independently reproduce that result. Neither `codex` nor `claude` is currently discoverable on this environment's `PATH`; real provider integration remains unverified here.

## 2. Current architecture

### 2.1 Repository and runtime shape

The repository uses npm workspaces and TypeScript project references.

```text
Browser (loopback only)
  -> Next.js 16 App Router UI and API (`apps/web`)
      -> Prisma client (`packages/database`)
          -> PostgreSQL 17 in Docker
      -> BullMQ producer
          -> Redis 7 in Docker

Native Node.js worker (`apps/worker`)
  -> BullMQ consumers and outbox dispatcher
  -> Codex/Claude provider registry (`packages/providers`)
  -> workspace/Git/command runtime (`packages/execution`)
  -> context capsules (`packages/context-engine`)
  -> Markdown project memory (`packages/project-memory`)
  -> PostgreSQL events/evidence/audit records

Browser
  <- SSE route polling persisted AgentEvent rows
```

The Windows launcher (`scripts/start-local.mjs`) starts PostgreSQL and Redis with Docker Compose, deploys Prisma migrations, starts the Next.js and worker processes natively, records exact process identities, and stops only launcher-owned process trees.

### 2.2 Current stack

| Area | Current implementation | Audit assessment |
| --- | --- | --- |
| Language | TypeScript 5.9, strict project references | Keep |
| UI/API | Next.js 16 App Router, React 19 | Keep |
| Styling | Tailwind/PostCSS plus app CSS | Keep unless a screen needs isolated refactoring |
| Local runtime | Node.js native worker | Keep as a runtime host; change its queue transport |
| Persistence | Prisma 6 with PostgreSQL | Keep Prisma; add a side-by-side SQLite v2 schema and validate connector behavior on Windows |
| Queue | Redis 7, BullMQ, transactional outbox | Replace required Redis/BullMQ with SQLite work claims; preserve the outbox/lease concepts |
| Validation | Zod 3 | Keep and expand |
| Process launch | `child_process` plus `cross-spawn`, argument arrays, `shell: false` | Keep the safe abstraction; prefer native `spawn` and retain a narrowly scoped Windows shim strategy |
| Live logs | Persisted events plus polling SSE | Keep; add artifact-backed stdout/stderr and cursor-safe event sequencing |
| Testing | Vitest, Testing Library, Playwright, temporary Git workspaces, disposable Postgres/Redis guards | Keep; replace infrastructure-dependent v2 tests with isolated temporary SQLite databases |
| Local services | Docker Compose for PostgreSQL/Redis | Remove from the default path; retain Docker only as an optional approved workspace capability |

### 2.3 Logical package responsibilities

- `apps/web`: dashboard, project/task/session/conversation/settings pages, API routes, CSRF, loopback checks, local-session bootstrap, and SSE endpoints.
- `apps/worker`: execution claiming, provider health, model health, cancellation observation, process ownership, review findings, evidence capture, worker leases, and queue consumers.
- `packages/shared`: Zod request schemas, capability matrix, hard-coded model registry, task capsules, verification helpers, loopback checks, test database/Redis guards, and locked-decision conflict checks.
- `packages/database`: Prisma client/schema/migrations, local sessions, conversation transactions, outbox handling, and verification cleanup.
- `packages/execution`: workspace validation, contained path resolution, fixed server command catalog, command execution, secret redaction, and Git inspection.
- `packages/providers`: provider-neutral CLI contract, executable discovery, Codex/Claude adapters, process runner, structured stream parsing, health/model probes, and registry.
- `packages/context-engine`: task capsule construction, context-health estimates, and checkpoint content.
- `packages/project-memory`: non-destructive `.ai-project` initialization, append-only Markdown updates, and immutable checkpoint files.

### 2.4 Current trust boundaries

Useful existing boundaries include:

- The web server binds to loopback and rejects non-loopback/proxied requests.
- Mutating requests pass same-origin CSRF checks.
- Selected conversation operations also require a server-issued local-session cookie.
- Repository paths are canonicalized, and contained paths are re-canonicalized to reject traversal, symlink, and Windows junction escapes.
- Browser input selects server-owned command IDs; it does not define executable strings or arguments.
- Provider and command processes use argument arrays with `shell: false`.
- Output is bounded and redacted before persistence.
- The worker is not directly exposed over HTTP.
- Tests fail closed unless configured for explicitly disposable database and Redis instances.

These are valuable foundations, but enforcement is inconsistent across routes and does not yet implement task approval as the authority boundary.

## 3. Existing functionality

### 3.1 Implemented in the repository

- Project registration for an absolute local Git repository.
- Server-side project-path validation, Git branch/commit/status/diff inspection, and recent commits.
- Fixed test, typecheck, lint, and build command definitions.
- Project archiving and project-specific model defaults.
- Structured tasks with objective, request, constraints, prohibited changes, relevant files, priority, criteria, and evidence mappings.
- Task capsules and context-health calculations.
- Task execution sessions with persisted lifecycle, provider attribution, model selection, reasoning effort, usage, exit state, timeout state, and cancellation state.
- Codex CLI implementation mode and read-only modes.
- Claude CLI review/verification plus a controlled workspace-write implementation mode.
- Windows CLI executable resolution for `.exe` and `.cmd` candidates.
- Provider installation/version/authentication/model probes.
- Structured Codex JSONL and Claude stream-JSON parsing.
- Process timeout, cancellation, process-tree termination, PID/start-identity tracking, worker leases, and stale-run recovery.
- Git status/diff/changed-file evidence and allowlisted command evidence.
- Claude review findings and user accept/reject actions.
- Acceptance-criterion evidence gating and checkpoint creation/resume.
- Decisions, including locked-decision conflict checks.
- Append-only `.ai-project` memory files and checkpoint files.
- Provider health and settings screens.
- Persisted SSE execution logs.
- A provider-switching conversation timeline, provider sessions, routing decisions, handoff capsules, retries, and idempotency for conversation messages.
- Local startup/status/stop scripts that track owned process trees.

### 3.2 Current UI surfaces

The current navigation exposes Projects, Agent Sessions, Project Memory, Decisions, Checkpoints, Evidence, and Settings. Project detail includes Git/provider/context health, task creation, recent tasks, model defaults, and conversations. Task detail includes execution actions, logs, evidence, findings, and checkpoints.

The following Relay v2 screens do not yet exist as distinct workflows: Dashboard summary, Task Inbox, Import Handoff, Approval View, Git Diff and Results, Review Findings as a run-level view, MCP Settings, Audit Log, and provider transmission previews.

### 3.3 Existing test evidence and limits

There are 44 tracked test/spec files across web, worker, packages, launcher scripts, and browser E2E coverage. Existing tests cover important parts of:

- path containment and junction escape rejection;
- command allowlisting and destructive-command approval at the runner boundary;
- secret redaction, including split chunks;
- Git diff/status capture;
- CLI discovery and structured stream parsing;
- provider health/model behavior with fakes;
- timeout, cancellation, process ownership, leases, duplicate worker delivery, and retry behavior;
- conversation message idempotency/concurrency;
- local-only, CSRF, and test-database boundaries;
- UI conversation behavior and browser polling/provider attribution.

The provider unit tests use mocked executables and streams. The current ignored verification report marks code/test/build stages as passing, but real Codex and Claude smoke tests are intentionally separate. This audit confirmed that both CLIs are absent from `PATH` in the current managed environment, so no real CLI claim should be made.

## 4. Reusable components

| Existing component | Reuse in Relay v2 | Required adaptation |
| --- | --- | --- |
| TypeScript workspace and strict compiler settings | Direct reuse | Add references for new domain/orchestrator/handoff modules |
| Next.js UI/API shell | Direct reuse | Replace conversation-first navigation with task inbox/approval/results flows |
| `validateWorkspace` and `resolveInsideWorkspace` | High-value reuse | Add path policy, secret-file denial, canonical case-insensitive path key, UNC/reparse-point tests, and configurable allowed roots |
| Server-owned command catalog | High-value reuse | Expand two levels into SAFE/REVIEW/DANGEROUS/BLOCKED and attach purpose, approval, platform, and side-effect metadata |
| Shell-free process launch | High-value reuse | Make incremental event delivery real for every process, persist artifact paths, capture command capability snapshots, and prove tree termination |
| Windows executable resolver | High-value reuse | Add `--help`, subcommand help, version hash, supported-flag parsing, and a diagnostic report |
| Codex and Claude structured parsers | Reuse behind adapters | Version/fixture characterize each installed CLI; never assume event or flag support |
| Provider registry and contract | Reuse concept | Split coding executors from optional orchestration APIs; add capabilities and unsupported-option results |
| Worker lease and process-ownership logic | Reuse algorithms | Replace Redis delivery with SQLite claims and add a canonical-workspace write lease |
| Transactional outbox behavior | Reuse concept | Store durable local work in SQLite; no network queue is required |
| Persisted events and SSE | Direct reuse pattern | Add authorization, stream/run ownership checks, artifact links, and resume cursors |
| Git inspection/evidence | High-value reuse | Add pre-run snapshots, binary-safe patch artifacts, before/after file sets, diff limits, and explicit dirty-worktree policy |
| Task capsule/context engine | Partial reuse | Consume validated Relay task specs, redact/exclude secrets, select only approved context, and hash the exact transmitted capsule |
| Decisions and evidence | Partial reuse | Normalize state, associate with tasks/runs, and route all writes through orchestrator services |
| Project memory files | Partial reuse | Change from immediate append operations to database-derived, reviewable document generation |
| Loopback/CSRF/test fail-closed helpers | High-value reuse | Require local identity consistently on all operational routes and prepare scoped MCP authentication hooks |
| Launcher process ownership | High-value reuse | Remove required Docker dependencies and launch web/runtime against one local data directory |
| Existing tests and fixtures | High-value reuse | Port to isolated SQLite and add Relay v2 domain/security/MCP contracts |

## 5. Components to replace or retire

The following should be replaced incrementally, not deleted during the early milestones:

1. **PostgreSQL as the mandatory local database.** Replace it with a new SQLite v2 store. Keep PostgreSQL read-only and recoverable through cutover validation.
2. **Redis/BullMQ as the required local queue.** Replace it with durable SQLite work records, transactional claims, leases, retry timestamps, and a native polling runtime.
3. **Conversation-first execution.** The current conversation message route can create and queue an `AgentSession`, including implementation mode. Relay v2 must not expose this as the primary task path. Preserve it as a feature-flagged legacy surface until v2 task import/history migration is accepted.
4. **Current `TaskStatus` and scattered direct status updates.** Replace them with the Relay v2 state machine and a single transition service.
5. **Current approval model.** An approval is project/action scoped and can be reused by any matching command. Replace it with task/run/operation-digest-scoped approvals, dedicated dangerous-operation approvals, explicit resolvers, and complete audit events.
6. **Hard-coded `MODEL_REGISTRY` and fixed CLI flags.** Replace with provider capability snapshots, a configurable model catalog, safe model probes, and user/project overrides. `AUTO` may omit a model and use the CLI default when no validated catalog entry exists.
7. **Immediate Markdown memory writes.** Replace with memory candidates in SQLite, user verification, and deterministic generated views.
8. **Two-level command categories (`safe`/`destructive`).** Replace with SAFE/REVIEW/DANGEROUS/BLOCKED plus explicit workspace policy and task approval gates.
9. **Database-resident output as the only run record.** Keep bounded searchable events, but move full redacted stdout, stderr, patches, and result artifacts to controlled local files with hashes and database metadata.
10. **Provider probes as a substitute for capability discovery.** Keep opt-in connection/model probes, but use local help/version inspection for supported flags before any paid or authenticated prompt.
11. **Legacy conversation/session schema as the v2 domain.** Preserve for migration/history, but use `Task`, `ExecutionRun`, `ReviewRun`, and `ContextSnapshot` as the v2 workflow source of truth.

## 6. Technical debt

### 6.1 Domain and architecture debt

- API routes, database writes, routing, queueing, workspace inspection, filesystem memory updates, and audit writes are frequently combined in one handler. Failures can leave partial cross-system state.
- There is no explicit application/orchestrator layer. State transitions are direct Prisma updates spread across web and worker code.
- Several lifecycle concepts are free-form strings (`purpose`, capability, finding status, actions) rather than validated domain types at every boundary.
- `Task`, `AgentSession`, conversation execution, evidence, and checkpoint concepts overlap without one canonical v2 lifecycle.
- The task path lacks task-level idempotency, duplicate prevention, external IDs, task source/type/complexity, selected executor/model/effort, reviewer policy, and acceptance timestamps.
- The old and newer conversation execution paths have different provider-selection rules and capabilities.

### 6.2 Maintainability debt

- Many routes, components, and worker files are compressed into dense one-line code, making security review and change isolation difficult.
- Some UI pages swallow database errors and present empty data, obscuring operational failures.
- `@typescript-eslint/no-explicit-any` is disabled globally, and several database/UI paths use `any` or type assertions at trust boundaries.
- Some docs/UI strings show mojibake such as `â†’` and `Â·`, indicating an encoding consistency issue.
- `apps/web/next-env.d.ts` is tracked but is rewritten between Next.js dev/build modes, creating recurring unrelated diffs.
- Existing architecture and known-issue documents lag newer functionality such as Claude implementation and conversation orchestration.

### 6.3 Execution and evidence debt

- The general command runner buffers stdout/stderr and invokes its event callback only after close; this is not truly incremental logging.
- There is no canonical-workspace write lock. Worker leases prevent duplicate ownership of one session but do not prevent two different write sessions in the same repository.
- A baseline commit and diff hash are captured, but there is no complete pre-run checkpoint artifact with before/after manifest, patch checksum, and recovery instructions.
- Git diff output is bounded in memory and can lose full evidence for large or binary changes.
- Command risk is defined by a static category on a small catalog, not by executable/arguments/purpose/workspace policy together.
- CLI adapters encode flags instead of inspecting the locally installed version's help text.

### 6.4 Persistence and operations debt

- Local startup depends on two Docker services even though the product is single-user and local-first.
- Automated integration tests need disposable PostgreSQL and Redis, increasing setup time and failure modes.
- The current local session token is stored in plaintext and has no expiry policy.
- Runtime logs, verification artifacts, database records, and workspace memory files have no unified retention policy.

## 7. Security concerns

| Severity | Concern | Current evidence | Relay v2 mitigation |
| --- | --- | --- | --- |
| Critical workflow gap | Task/execution approval is not a mandatory state boundary | Task creation uses `PLANNED`; session creation can immediately queue after a UI action; conversation `IMPLEMENT` queues directly | A task is created as `PENDING_APPROVAL`; only the orchestrator can transition through approval to queue; external tools cannot call execute |
| High | Approved destructive commands are project/action scoped and reusable | Worker searches any approved `command:<id>` for the project | Scope approval to task, run, normalized operation digest, risk, and expiry; consume once; audit request and resolution |
| High | No workspace-wide write exclusion | Leases are per `AgentSession` | Unique canonical workspace lease for all write-capable runs; stale recovery requires PID/start-identity proof |
| High | Context creation can read user-selected files such as `.env` | Relevant files are resolved and read without a secret-file policy | Deny `.env*`, credentials, keys, VCS credential files, and configurable secret globs before read; redact after selection and before every sink |
| High | Operational authentication is inconsistent | Conversation writes require local session; several project/task/session/approval routes rely only on loopback + CSRF | Require a local identity and project authorization for every operational route; hash session tokens and expire/revoke them |
| High | Current CLI flags can drift from installed versions | Adapters hard-code Codex/Claude options | Persist sanitized version/help capability snapshot; construct argv only from detected features; reject unsupported settings |
| High | External-transmission controls do not exist | No Gemini/DeepSeek adapters or transmission records | Default `METADATA_ONLY`; preview provider, purpose, selected files, redactions, byte estimate, and hash; explicit approval for source/document content |
| Medium | Secret redaction is pattern-based and not uniformly applied before reads | Good output patterns exist, but there is no central source-context policy | Central secret policy: path exclusion, entropy/pattern scanning, streaming redaction, sink-specific tests, and no `.env` logging |
| Medium | Audit records lack task association and risk level | Current `AuditEvent` has project, actor, action, details | Add `taskId`, actor type/ID, `riskLevel`, correlation/run IDs, schema-validated details, immutable insert-only access |
| Medium | SSE/read APIs do not consistently demonstrate local-session/project checks | Session SSE reads by supplied session ID | Authenticate and verify run-to-project access before streaming; use opaque IDs plus consistent not-found behavior |
| Medium | Local session bearer token is plaintext in PostgreSQL | `LocalSession.token` is unique and directly queried | Store only a keyed hash, use secure/httpOnly/sameSite cookie settings, TTL, rotation, and logout/revoke |
| Medium | Cross-system writes are not atomic | Task creation writes DB, capsule, Markdown, and memory DB records sequentially | Commit database state first; generate external files through idempotent jobs after approval; record/retry failures |
| Medium | Output/artifact retention and permissions are undefined | Bounded DB output and ignored local artifacts exist | App-owned data directory, restrictive ACL checks on Windows, size/retention limits, hashes, and user-controlled cleanup |
| Medium | Fixed loopback database passwords are documented defaults | Compose uses known credentials on loopback | SQLite removes network credentials from the MVP; Docker remains optional and loopback-only |
| Low/unknown | Current dependency advisory status was not rechecked in this audit | Lockfile is current to the repository; older docs mention advisories | Run an approved current dependency/advisory review before each implementation milestone; do not claim status from stale docs |

Safety invariants for all v2 milestones:

- No external caller can create an approved or running task.
- No model output is executable authority.
- No command is formed by concatenating untrusted shell text.
- No API key is stored in SQLite, source, logs, Git, or plaintext settings.
- No source transmission occurs without a recorded policy decision; source-bearing Gemini/DeepSeek calls require explicit approval.
- No DANGEROUS operation uses the general task approval; it requires a dedicated operation approval.
- BLOCKED operations cannot be approved through the normal workflow.

## 8. Migration risks

| Risk | Impact | Control |
| --- | --- | --- |
| PostgreSQL-to-SQLite conversion loses or changes data | Lost history or broken relations | Copy, never move; export source counts/checksums; preserve IDs/timestamps; produce a per-table migration report; leave PostgreSQL volume untouched |
| Two runtimes can claim the same work during cutover | Concurrent edits | Feature flag one execution authority; drain old BullMQ queues; disable legacy write entry points before enabling SQLite runtime |
| Existing task states do not map one-to-one | Incorrect approval/terminal state | Explicit mapping table; ambiguous rows become `BLOCKED` and require user resolution, never inferred as approved/completed |
| Existing conversations conflict with the task-first product | User history loss or accidental execution | Preserve as read-only legacy history; import only explicit tasks/results; hide legacy execute controls after cutover |
| SQLite write contention | Missed events or stalled execution | WAL mode, short transactions, busy timeout, one local writer runtime for high-volume events, batched event inserts, and contention tests |
| Prisma SQLite connector differences | Schema/type or migration surprises | Milestone 1 proof with JSON/date/index/transaction tests on Windows before data import; use normalized child tables where connector behavior is unsuitable |
| CLI version/flag changes | Failed runs or unsafe permissions | Local help/version characterization, adapter fixture snapshots, unsupported-option errors, and opt-in real smoke tests |
| Dirty workspaces obscure agent changes | Incorrect diff or rollback | Capture exact pre-run snapshot and patch; default to blocking write execution unless user explicitly acknowledges the dirty baseline |
| Large/binary diffs overwhelm DB/UI | Truncation or memory pressure | Stream artifacts to files, store hashes/metadata, cap previews, and mark truncation explicitly |
| Markdown/database divergence | Stale or false memory | Database is authoritative; deterministic generated documents; atomic replace only after preview approval |
| Provider context leaks secrets | Credential exposure | Path denylist, content scanning/redaction, exact context preview/hash, minimum necessary context, transmission audit |
| Existing user changes are overwritten | Loss of work | Never reset/checkout/delete them; record baseline before each milestone; isolate v2 edits and stop on overlap |
| Native credential-store package fails on Windows | Provider settings unusable | Defer package selection to a Windows proof-of-concept; no plaintext fallback; optional providers remain disabled if secure storage is unavailable |
| Local-auth hardening breaks the launcher/browser flow | App becomes inaccessible | Preserve loopback bootstrap with dedicated integration/E2E tests before route cutover |

Current working-tree risk: this audit began with a pre-existing modification to `apps/web/next-env.d.ts` and an untracked `.claude/` directory. Both are user/environment changes and must remain outside Relay v2 milestone commits.

## 9. Proposed Relay v2 architecture

### 9.1 Deployment shape

Relay v2 remains one local product and one repository. Two native Node processes are acceptable as implementation hosts—the Next.js web process and a supervised runtime process—but they share one SQLite source of truth and ship/start/stop together. There is no Redis, network queue, cloud executor, or inbound remote bridge.

```text
ChatGPT clipboard/YAML/JSON        Future MCP client
             |                          |
             v                          v
      Handoff boundary ---------- MCP boundary (Milestone 6)
             |                          |
             +----> versioned Zod validation
                           |
                           v
Browser -> Next.js UI/API -> Orchestrator/application services
                           |  - state machine
                           |  - approvals
                           |  - deterministic routing
                           |  - audit
                           v
                      SQLite (WAL)
                           |
                   durable work claim
                           |
                           v
                  Native runtime process
                  |        |          |
             workspace   adapters   memory renderer
             runtime     Codex      DB -> Markdown
                         Claude
                         Gemini* / DeepSeek*

* Optional and disabled by default; never coding executors.
```

### 9.2 Module responsibilities

**User interface**

- Dashboard, Projects, Task Inbox, Create/Import Task, Task Detail, Approval, Live Execution, Diff/Results, Review Findings, Memory, Provider Diagnostics/Settings, MCP Settings, and Audit Log.
- UI calls application services through local API routes; it does not invoke adapters or process launchers directly.

**Orchestrator**

- Owns handoff acceptance, task classification, state transitions, routing, approvals, run/review creation, retry/escalation policy, result acceptance, memory candidates, and audit events.
- Uses deterministic rules first. Optional providers can recommend but never decide authority, risk, approval, or execution.

**Agent adapters**

- `CodexCliAdapter` and `ClaudeCodeAdapter` implement local coding/review execution.
- `GeminiApiAdapter` and `DeepSeekApiAdapter` implement the separate `OrchestratorProvider` interface and are optional.
- Provider capability discovery, model catalog, health, and execution are separate concerns.

**Workspace runtime**

- Canonical project paths, contained file selection, Git snapshots/diffs, workspace leases, process runner, Docker command catalog, command risk, cancellation/timeouts, artifacts, and secret policy.
- Only server-owned operation definitions are executable. External callers submit task intent, never arbitrary commands.

**Memory engine**

- Stores memory entries, decisions, issues, context snapshots, evidence, and generated-document revisions in SQLite.
- Generates `PROJECT_STATE.md`, `DECISIONS.md`, `OPEN_ISSUES.md`, and `HANDOFF.md` as reviewable projections. It does not treat unverified model output as fact.

**Integration layer**

- Versioned YAML/JSON/clipboard/file handoff in Milestone 1.
- MCP server in Milestone 6 only after local approval/execution is stable.
- Remote bridge remains design-only until explicit approval after Milestone 6.

### 9.3 Controlled task state machine

All transitions go through one transactionally audited service. Direct status updates outside persistence internals are forbidden.

| From | Allowed next states | Guard |
| --- | --- | --- |
| `DRAFT` | `PENDING_APPROVAL`, `CANCELLED` | Valid v1 task spec required for submission |
| `PENDING_APPROVAL` | `APPROVED`, `CANCELLED` | Approval records exact selected executor/model/effort/reviewer/permissions/spec hash |
| `APPROVED` | `QUEUED`, `CANCELLED` | Approval still current; no changed task/config hash |
| `QUEUED` | `RUNNING`, `BLOCKED`, `CANCELLED` | Durable work claim and workspace policy pass |
| `RUNNING` | `AWAITING_REVIEW`, `AWAITING_USER_ACCEPTANCE`, `FAILED`, `BLOCKED`, `CANCELLED` | Exit/process/Git evidence determines result; provider prose cannot mark success |
| `AWAITING_REVIEW` | `REVIEW_FAILED`, `AWAITING_USER_ACCEPTANCE`, `FAILED`, `CANCELLED` | Review run reaches a validated terminal verdict |
| `REVIEW_FAILED` | `PENDING_APPROVAL`, `BLOCKED`, `CANCELLED` | Retry/remediation creates a new approval and run |
| `AWAITING_USER_ACCEPTANCE` | `COMPLETED`, `PENDING_APPROVAL`, `CANCELLED` | User accepts result or requests an edited/retried task |
| `FAILED` | `PENDING_APPROVAL`, `BLOCKED`, `CANCELLED` | Retry policy recommends only; user reapproves |
| `BLOCKED` | `PENDING_APPROVAL`, `CANCELLED` | Blocking reason resolved and task resubmitted |
| `COMPLETED`, `CANCELLED` | none | Terminal |

Creating or importing a task ends at `PENDING_APPROVAL`. It never queues a run.

### 9.4 Routing and model selection

Deterministic local classification returns task type, TRIVIAL/NORMAL/COMPLEX/CRITICAL complexity, risk, executor capabilities, recommended effort, and reviewer policy. Inputs include declared task type, affected domains, migration/auth/payment/security indicators, expected file scope, destructive intent, and user constraints.

Selection order:

1. Validate explicit user selection against installed provider capabilities and enabled model catalog.
2. Otherwise apply project defaults if valid.
3. Otherwise apply application routing policy.
4. Otherwise omit a model flag and use the CLI's own default.
5. Never invent or silently substitute an unsupported model/effort.

TRIVIAL and NORMAL default to medium effort. COMPLEX defaults to high effort and recommends a reviewer. CRITICAL requires high effort, reviewer, explicit task approval, and any dedicated dangerous-operation approvals. Maximum effort is never a blanket default.

On first failure, Relay may recommend a higher supported effort for the same model. On repeated failure, it may recommend a validated stronger catalog entry or alternate executor. Every retry is a new run and approval decision; no failure auto-executes a retry.

### 9.5 CLI capability discovery

For each CLI, the diagnostic service will:

1. Resolve a canonical executable using safe Windows-aware discovery.
2. run `--version` with a short timeout;
3. run root `--help` and the applicable non-interactive subcommand help;
4. sanitize and hash outputs;
5. parse only known capability markers into a typed snapshot;
6. display supported/unsupported options and the raw sanitized diagnostics on request;
7. cache against executable path, version, and help hash;
8. construct argv only from the snapshot;
9. fail clearly if a selected option is unsupported.

Connection and model probes remain separate, opt-in, bounded, read-only operations. Unit fixtures can test adapters without a CLI. Real smoke tests must skip with an explicit reason when the executable/authentication is unavailable.

### 9.6 Workspace and execution lifecycle

1. Revalidate the project's canonical path and Git repository.
2. Revalidate approval against the current task/config/policy hash.
3. Classify every planned operation.
4. Acquire a canonical-workspace write lease for write-capable execution.
5. Create a pre-run `ContextSnapshot` and artifact set: branch, HEAD, status, changed-file manifest, diff/patch, hashes, and selected context.
6. Create stdout/stderr artifact files with restrictive local permissions.
7. Spawn the detected executable with a fixed argv array, working directory, safe environment, timeout, and cancellation controller.
8. Stream redacted chunks to bounded events and artifact files.
9. Record exit code and termination proof. A non-zero/unknown exit cannot be success.
10. Capture after-state, changed files, patch, test/build evidence, and diff truncation metadata.
11. Release the lease in a crash-safe finally/recovery path.
12. Route to review or user acceptance according to policy.

A pre-run checkpoint is a Relay snapshot/patch artifact, not an automatic Git commit, tag, stash, reset, or branch mutation. An actual commit remains a separate user-approved action.

## 10. Proposed folder structure

This is a target reached incrementally. Existing package names remain during adaptation to avoid a flag-day rewrite.

```text
apps/
  web/                         Next.js UI and local API host
    app/
      dashboard/
      projects/
      tasks/
      approvals/
      executions/
      memory/
      settings/
      audit/
      api/
    components/
  runtime/                     renamed/evolved native worker host
    src/
      execution-loop.ts
      recovery.ts
      diagnostics.ts
  mcp/                         Milestone 6 entry point only

packages/
  domain/                      entities, enums, Relay handoff v1, state machine
  orchestrator/                use cases, routing, approval/retry policies
  persistence/                 Prisma SQLite client, repositories, migrations
  workspace-runtime/           paths, Git, process runner, locks, risk, redaction
  agent-adapters/
    src/cli/                   Codex and Claude
    src/api/                   Gemini and DeepSeek (Milestone 5)
  memory-engine/               entries, snapshots, generated Markdown views
  integrations/
    src/handoff/               YAML/JSON/clipboard/file import
    src/mcp/                   tool handlers/auth/rate-limit hooks (Milestone 6)
  shared/                      small cross-boundary DTO/utilities only

prisma/
  relay-v2.schema.prisma       side-by-side SQLite schema during migration
  migrations-v2/

docs/
  ARCHITECTURE.md
  LOCAL_SETUP.md
  TASK_HANDOFF_FORMAT.md
  CODEX_ADAPTER.md
  CLAUDE_ADAPTER.md
  GEMINI_ADAPTER.md
  DEEPSEEK_ADAPTER.md
  MEMORY_ENGINE.md
  SECURITY.md
  MCP_CHATGPT_SETUP.md
  TROUBLESHOOTING.md
  SMOKE_TEST.md

scripts/
  migrate-v1-to-v2.ts
  verify-migration.ts
  smoke-*.ts

.relay-data/                   development-only ignored data root
  relay.db
  artifacts/
  logs/
  backups/
```

Production-local data should default to an app-owned directory such as `%LOCALAPPDATA%\Relay`, configurable through `RELAY_DATA_DIR`. Repository-local `.relay-data` is suitable only for this development workspace and must stay ignored. API keys are never files in either location.

Incremental package mapping:

| Current | Target |
| --- | --- |
| `packages/shared` domain sections | `packages/domain` |
| `packages/database` | `packages/persistence` |
| `packages/execution` | `packages/workspace-runtime` |
| `packages/providers` | `packages/agent-adapters` |
| `packages/context-engine` + `packages/project-memory` | `packages/memory-engine` |
| Web/worker routing logic | `packages/orchestrator` |
| New YAML/JSON and later MCP handlers | `packages/integrations` |
| `apps/worker` | `apps/runtime` after queue cutover is proven |

## 11. Proposed database schema

### 11.1 Storage rules

- SQLite is the local source of truth, with foreign keys enabled, WAL mode, a bounded busy timeout, and explicit transactional repositories.
- IDs are application-generated opaque text IDs. Existing IDs are preserved during import.
- Timestamps are UTC and serialized consistently.
- Status/type values are validated by Zod and protected by migration-level `CHECK` constraints where Prisma cannot express them.
- Structured arrays/objects use validated JSON only where SQLite/Prisma support is verified; otherwise use normalized child tables or explicit text codecs validated on every read/write.
- No schema contains an API-key, token, password, private-key, or credential-value column.

### 11.2 Core entities

| Entity | Fields and constraints |
| --- | --- |
| `Project` | `id`, `name`, unique `slug`, `localPath`, unique canonical case-folded `pathKey`, `description`, `defaultExecutor`, `defaultReviewer`, `defaultModel`, `defaultEffort`, `createdAt`, `updatedAt`; archive field retained as a useful extension |
| `Task` | All requested fields: `id`, `projectId`, `externalId`, `idempotencyKey`, `title`, `objective`, `source`, `taskType`, `complexity`, `status`, `context`, `constraints`, `acceptanceCriteria`, suggested/selected executor-model-effort, `reviewer`, `requireApproval`, and lifecycle timestamps; add `updatedAt`, `specVersion`, `specHash`, and `permissions` policy snapshot; unique `(projectId, source, idempotencyKey)` and nullable unique external identity per source |
| `ExecutionRun` | `id`, `taskId`, provider/model/effort, status, process ID/start identity, display-safe command, start/finish, exit code, stdout/stderr paths, summary, failure code/reason; add `attempt`, `capabilitySnapshotId`, `approvalId`, `workspaceLeaseId`, `beforeSnapshotId`, `afterSnapshotId`, cancellation/timeout fields, and timestamps |
| `Approval` | `id`, `taskId`, optional `executionRunId`, `approvalType`, requested/resolved actors, status, schema-validated details, `specHash` or `operationDigest`, request/resolution/expiry timestamps; one active pending approval per scoped purpose |
| `ReviewRun` | `id`, `taskId`, optional reviewed `executionRunId`, provider/model, status, validated findings, verdict, prompt/context hash, start/finish, failure reason |
| `Decision` | Requested project/task/title/context/decision/consequences/timestamp fields; retain status, lock, creator, supersession, forbidden paths, and required patterns |
| `Issue` | Requested project/task/title/severity/status/details/create/resolve fields; add source and verification metadata |
| `ContextSnapshot` | Requested project/task/Git branch/commit/status/selected files/summary/timestamp; add run ID, diff/artifact references, content hashes, dirty flag, and snapshot type (`PRE_RUN`, `POST_RUN`, `HANDOFF`) |
| `MemoryEntry` | Requested project/task/category/title/content/confidence/verified/create/update fields; add source type/reference, verifiedBy/verifiedAt, supersededBy, and evidence refs |
| `AuditEvent` | Requested project/task/actor/action/risk/details/timestamp; add run/approval correlation IDs and actor type; insert-only repository |
| `ProviderConfiguration` | Requested provider/enabled/default model/timeouts/input/output/purposes/usage limit/timestamps; unique provider; stores policy and metadata only, never secrets |

`constraints` and `acceptanceCriteria` remain fields in API projections as required. Persistence should normalize them for ordering, evidence links, and independent status:

- `TaskConstraint(id, taskId, ordinal, text)`
- `AcceptanceCriterion(id, taskId, ordinal, description, status, createdAt, updatedAt)`

The Task repository assembles these into the Relay task DTO. During migration, legacy JSON can be retained in a raw import snapshot for audit without becoming the active v2 representation.

### 11.3 Supporting entities

| Entity | Purpose |
| --- | --- |
| `ExecutionEvent` | Ordered redacted state/stdout/stderr/usage/policy events; unique `(executionRunId, sequence)` for SSE resume |
| `ExecutionArtifact` | Kind, local relative path, size, SHA-256, media type, truncation/redaction flags, creation time |
| `TestResult` | Run/criterion, command ID, status, exit code, timing, artifact, summary |
| `ReviewFinding` | Review run, severity, title, details, file/line, status, stale flag, resolution |
| `WorkspaceLease` | Unique canonical `pathKey`, mode, run ID, runtime PID/start identity, acquire/heartbeat/expiry/release timestamps |
| `ProviderCapabilitySnapshot` | Provider, executable path hash, version, sanitized help hash, typed supported flags/modes, checkedAt |
| `ModelCatalogEntry` | Provider, user-configurable model ID/display label, enabled purposes, effort values, source, validation status/time; no marketing names in business logic |
| `TransmissionRequest` | Provider, purpose, mode, payload bytes/hash, selected items, redaction summary, source-code flag, approval/status/timestamps |
| `GeneratedDocument` | Project, document type, content hash, source revision, preview/accepted/published state, target path, timestamps |
| `WorkItem` | Durable local queue record: kind, aggregate ID, status, attempt, available/claimed/lease times, owner identity, last safe error |
| `IdempotencyRecord` | Optional general integration response cache when task uniqueness alone is insufficient; source, key, request hash, result reference, timestamps |

### 11.4 Current-to-v2 data mapping

| Current data | v2 target | Rule |
| --- | --- | --- |
| `Project` | `Project` | Preserve ID/name/path/timestamps; derive slug/path key; map default provider/model fields |
| `Task` + `AcceptanceCriterion` | `Task` + criteria/constraints | Preserve ID/content; map unambiguous statuses; ambiguous active states become `BLOCKED` pending review |
| `AgentSession` | `ExecutionRun` | Preserve provider/model/effort/timing/exit/failure/ownership; link evidence/artifacts |
| `AgentEvent` | `ExecutionEvent` | Preserve order and redacted text |
| `Evidence` | `TestResult` or `ExecutionArtifact` | Map by kind; preserve raw legacy ID in metadata |
| `ReviewFinding` | `ReviewRun` + `ReviewFinding` | Group by session; unknown verdict remains incomplete, never inferred pass |
| `Approval` | legacy audit plus scoped `Approval` only when safely attributable | Never convert a project-wide approval into a v2 execution authorization |
| `Decision` | `Decision` | Preserve accepted/locked/supersession metadata |
| `Checkpoint` | `ContextSnapshot`/artifact | Preserve content and Git metadata |
| `MemoryUpdate` | `MemoryEntry` candidate | Default `verified=false` unless evidence/user verification proves otherwise |
| `AuditEvent` | `AuditEvent` | Preserve details; set missing risk/task fields to explicit null/legacy values |
| `ProviderHealth`, `ModelHealth`, settings | configuration/capability/catalog | Import settings; refresh live health/capabilities rather than trusting stale availability |
| Conversations/messages/handoff capsules | read-only legacy history or handoff snapshots | Do not let legacy conversation rows authorize v2 execution |
| Outbox/BullMQ jobs | none after drain | Terminalize/drain before cutover; never replay blindly |

## 12. Proposed dependencies

### 12.1 Retain

- TypeScript, Next.js, React, Node.js, Prisma/`@prisma/client`, Zod, Vitest, Testing Library, Playwright, and ESLint.
- Existing Node built-ins for filesystem, crypto, streams, process control, and HTTP/SSE.
- `cross-spawn` only where required for a validated Windows command shim; native `child_process.spawn` remains the default execution primitive and always receives an argument array.

No dependency upgrades should be mixed into Milestone 1 unless required for a verified SQLite blocker or security fix. Any upgrade gets its own compatibility and advisory review.

### 12.2 Add when its milestone begins

- `yaml` in Milestone 1 for safe YAML 1.2 parsing. Disable custom tags/schema features not needed by Relay and validate the parsed value with Zod.
- No extra SQLite service or queue package initially: use Prisma's SQLite connector and a `WorkItem` table after a Windows proof test.
- A Windows-capable OS credential-store adapter in Milestone 5, selected only after a native install/read/write/delete proof, maintenance/license review, and log-leak tests. There is no plaintext fallback.
- The current official MCP TypeScript SDK in Milestone 6, with the package/version selected only after checking official MCP/OpenAI documentation at that time.
- Prefer built-in `fetch` and small provider-specific clients for Gemini/DeepSeek unless current official SDKs provide necessary schema/multimodal behavior and pass the dependency review.

### 12.3 Remove after validated cutover

- `bullmq` and `ioredis` after all execution and health work uses SQLite claims.
- Required PostgreSQL/Redis Docker Compose services from the default launcher. Keep optional Docker command support for approved project workflows.

Do not add Kubernetes, Redis replacements, cloud queues, microservices, browser automation, desktop scraping, or paid OpenAI/Anthropic API dependencies.

## 13. Milestone plan

Every milestone begins by showing branch/status and a file-level change plan, preserves unrelated user work, runs relevant tests, reports changed files/limitations, and waits for approval before one focused commit.

### Milestone 0 — repository audit (this document)

- Inspect current architecture, functionality, risks, tests, and local CLI availability.
- Create only `RELAY_V2_PLAN.md`.
- No application code, dependencies, database, deployment, or commit changes.

Exit: user approves or edits this plan.

### Milestone 1 — local projects and task inbox

- Prove Prisma SQLite behavior on Windows and create the side-by-side v2 database.
- Implement domain enums, handoff v1 Zod schema, human-readable validation issues, deterministic state machine, repositories, idempotency, duplicate prevention, task approval records, and audit writes.
- Implement Projects, Add Project, Task Inbox, Create Task, Import Handoff, Preview, Task Detail, and Approval View.
- Support JSON, safe YAML, paste, clipboard button, file import, manual creation, and template copy.
- Create all tasks as `PENDING_APPROVAL`; no agent process or execution queue is available.
- Add a read-only migration report/import path for selected legacy projects/tasks without deleting PostgreSQL data.

Exit: task creation/import/idempotency/state/approval tests pass; UI proves no create/import path can execute.

### Milestone 2 — provider-neutral execution engine with FakeExecutor

- Add durable SQLite execution sessions, append-only execution events, bounded redacted artifacts, transactional claims, exclusive canonical-workspace leases, heartbeat, cancellation, timeout, stale recovery, SSE, and execution UI.
- Implement only the provider-neutral executor contract and the in-process, non-writing FakeExecutor.
- Keep legacy execution recoverable and prove the v2 engine cannot transitively reach providers, process launch, Redis, BullMQ, Git mutation, Docker, MCP, or external APIs.

Exit: domain, persistence, engine, SSE, isolation, and browser tests pass; no real provider or project command is invoked.

### Milestone 2.1 — runtime and streaming hardening

- Allow native SSE reconnect with persisted cursor resume, deduplication, configurable test deadlines, and terminal cleanup.
- Require project ownership for cancellation while preserving loopback and CSRF enforcement.
- Extend dependency isolation scans through v2 app and component UI roots without treating executor display labels as integrations.
- Contain runtime-host tick failures with bounded redacted diagnostics and continued polling.

Exit: SSE reconnect, cancel authorization, UI isolation, and runtime-host failure regression tests pass; no real provider or command is invoked.

### Milestone 2.2 — workspace runtime and Codex executor

- **Implemented:** dependency-isolated path containment, read-only Git evidence, exact process ownership, redaction, cancellation, timeouts, persisted events/SSE, and native runtime hosting.
- **Implemented:** SQLite claims and canonical workspace leases remain the only v2 work-delivery mechanism; Redis/BullMQ are not used by v2.
- **Implemented:** approval-bound Codex write/non-production/timeout/verification/dirty-baseline policy. **Partial:** the broader SAFE/REVIEW/DANGEROUS/BLOCKED operation catalog and dedicated dangerous-operation approvals remain a later hardening item.
- **Implemented:** Codex executable/version/help discovery, sanitized capability snapshots, safe argv/stdin construction, diagnostics, bounded artifacts, pre/post Git evidence, result UI, and process/verification failure truthfulness. **Planned:** retry recommendation.
- **Hardened:** disposable real smoke uses a validated committed Git repository outside Relay; cancellation closes every pre/post-spawn window and retains leases until owned-process exit; diagnostics never expose raw executable paths; authentication evidence refreshes and remains distinct from execution truth; dirty baselines protect index, stash, and pre-existing path/content identity.
- **Implemented:** legacy execution remains unchanged and cannot own v2 sessions.

Exit: unit/integration tests pass; real Codex smoke test passes or is explicitly skipped because CLI/auth is absent; no unsupported configuration is silently accepted.

### Milestone 2.3A — reviewer workflow foundation

- **Implemented:** provider-neutral `RelayReviewer` contract, `ReviewRequest`/`ReviewVerdict`/`ReviewEvent` domain model (append-only verdict/event tables, terminal-immutable request row, all enforced by SQLite triggers, not only application code), and the `ReviewEngine` application service.
- **Implemented:** cryptographic evidence binding — a review request hashes the exact task spec/approval snapshot/execution capsule/baseline+final Git evidence/verification results/artifact set/final branch+HEAD at request time, and `ReviewEngine` rechecks every one of those hashes immediately before accepting a verdict, invalidating to `STALE` instead of silently updating the request if anything changed.
- **Implemented:** Zod-validated structured verdict (`APPROVE`/`REJECT`/`NEEDS_CHANGES`) with cross-field invariants — no blocking BLOCKER/HIGH finding on `APPROVE`, at least one blocking finding on `REJECT`, at least one required action on `NEEDS_CHANGES`; a structurally invalid or hash-mismatched reviewer response becomes `ERROR`, never `APPROVE`.
- **Implemented:** `FakeReviewer` only — in-process, read-only, six deterministic scenarios (approve/reject/needs_changes/invalid/failure/cancellation), scenario persisted for restart, explicitly diagnostic-only in the UI, and reviewing a `FakeExecutor` session requires both an engine-level flag and an explicit per-request diagnostic flag.
- **Implemented:** a review verdict changes only a separately computed `ReviewGateProjection` (see below), never `ExecutionSession`/`Task` status; no automatic reopen, rerun, file modification, acceptance, or commit follows from a review.
- **Implemented:** `packages/relay-v2-reviewer` depends only on `relay-v2-domain`, `relay-v2-persistence`, `local-safety`, and `zod` — dependency-isolation tests prove it cannot reach `SafeProcessRunner`, `node:child_process`, providers, or any real CLI/API/MCP integration.
- **Implemented (corrective pass after independent review, 2026-08-02):** reviewer-authority matching (`resolveReviewerAuthority`) binding task approval id/status/reviewer-selection, the task's current reviewer selection, execution executor id, and reviewer id — `fake-reviewer` can never produce an `AUTHORITATIVE` verdict, and is rejected for a `codex-cli` execution except through two narrow, separately-gated `DIAGNOSTIC` paths (a `FakeExecutor` diagnostic session, or a Codex test-double session behind a dedicated `RELAY_V2_FAKE_REVIEWER_DIAGNOSTIC` flag plus the existing test-mode/disposable-data-dir gate).
- **Implemented:** final verdict acceptance re-reads every source-of-truth row fresh and reruns eligibility, authority resolution, and full binding reconstruction immediately before persisting a verdict — not just an evidence-hash diff.
- **Implemented:** durable cancellation state (`CANCELLATION_REQUESTED`) with compare-and-swap finalization — cancellation and verdict persistence race safely, exactly one terminal outcome is ever created, and repeated cancellation is idempotent.
- **Implemented:** durable review claiming via a `ReviewRuntimeHost` (atomic `PENDING -> CLAIMED` CAS with owner id/lease token/heartbeat/expiry, restart-safe `PENDING` rows, conservative `STALE`/`CANCELLED` lease-expiry recovery, never inventing a verdict); API request handlers no longer run a reviewer inline.
- **Implemented:** `GET /api/v2/executions/{id}/reviews` checks execution-session project ownership before touching any `ReviewRequest` row, so a wrong-project or nonexistent execution is indistinguishable from one with zero reviews.
- **Implemented (second corrective pass after independent review, 2026-08-02):** a single canonical `ReviewInputCapsule` — including **live-read** task title/objective/context, execution status/summary, and two independent spec-integrity recomputations (`canonicalTaskSpecHash`, `taskNormalizedSpecHash`) alongside every evidence hash — is persisted verbatim as `reviewInputJson`/`reviewInputHash`; `requestHash` wraps `reviewInputHash` with the request's non-reviewer-visible identity (`requestedBy`, `attempt`); `Reviewer.review()` receives exactly the object parsed back from the persisted `reviewInputJson`, never task/execution fields reassembled from live rows at run time.
- **Implemented:** final revalidation now runs inside the same database transaction as the terminal status CAS and the `ReviewVerdict` insert, and additionally detects task title/objective/context/normalized-spec drift (previously only evidence/approval/authority drift was caught).
- **Implemented:** `ReviewVerdict.reviewRequestId` carries a database-level `UNIQUE` constraint (not only an application CAS) — a second verdict insert for the same review request fails at the database regardless of how it is attempted.
- **Implemented:** lease-bound verdict finalization — every terminal write (verdict/`STALE`/`ERROR`) re-proves the exact claimed ownership generation (`ownerId`, `leaseToken`, `claimAttempts`, live `leaseExpiresAt`) inside the same transaction as the write; an expired, superseded, or mismatched owner can never produce a verdict, and only `recoverStaleReviews` or a still-live owner's own `resolveFinalizationRace` may resolve an ownerless row.
- **Implemented:** `ReviewGateProjection` (`state`/`authority`/`reviewerId`/`reviewRequestId`/`verdictId`/`requestHash`/`commitAuthorityEligible`) replaces the plain `reviewGateStatus` string everywhere — API responses and UI always show authority alongside state, a `DIAGNOSTIC` `APPROVE` renders as "Diagnostic approval" and never as plain approval, and `canSatisfyAuthoritativeReviewGate` unconditionally returns `false` in this milestone (no auto-commit policy exists yet).
- **Implemented (third corrective pass after independent review, 2026-08-02):** every reviewer-visible **and reviewer-control** value is bound, not only the evidence capsule — FakeReviewer's `reviewerConfigJson` (outcome/delay/summary/findings/required-actions) directly determines the verdict, so it is validated against a per-reviewer schema (`reviewerConfigSchemaFor`), canonicalized, and hashed into `reviewerConfigHash`; `requestHash` now composes `{ reviewInputHash, reviewerConfigHash, reviewerId, reviewAuthority, requestedBy, attempt, reviewPolicyVersion }`.
- **Implemented:** `ReviewEngine.verifyImmutableInputBinding` independently re-parses, re-validates, and re-hashes `reviewInputJson`/`reviewerConfigJson` and reconstructs `requestHash` from scratch — never trusting a persisted hash merely because a database trigger protects it — both immediately before the reviewer is ever invoked (a mismatch here means the reviewer is **never called**) and again inside the lease-qualified finalization transaction, before any live evidence reconstruction. Either failure moves the request to `STALE` with a distinct `failureCode: "REVIEW_IMMUTABLE_INPUT_MISMATCH"` (versus `"EVIDENCE_CHANGED"` for live-evidence drift), so the audit trail always records which layer actually failed.
- **Implemented:** a database-level `BEFORE UPDATE` trigger, `ReviewRequest_immutable_payload`, rejects any change to the request's full authority/evidence/binding payload (including the new `reviewerConfigHash`) in **every** status — `PENDING`/`CLAIMED`/`RUNNING`/`CANCELLATION_REQUESTED` included, not only once terminal — while still permitting the controlled lifecycle/lease columns to change; proven both by direct-update rejection tests in every non-terminal status and by hand-seeded corrupt/legacy-row fixtures that reach `ReviewEngine` only via `INSERT` (which the trigger does not govern) and are still caught and refused a verdict at runtime.
- **Fixed:** the concurrent unique-verdict test previously raced two inserts against a request that already had a verdict (proving nothing about a genuine first-slot race); it now races two concurrent inserts against a zero-verdict request and asserts exactly one wins, repeated to reduce flakiness.
- **Verified:** the Milestone 2.3A migration (still uncommitted, modified in place — no new migration created) applies cleanly both on a fresh database and incrementally on top of an existing Alpha 0.3 database (migrations 1-3 already applied, migration 4 deployed separately afterward).
- **Not implemented in this milestone:** a real Claude CLI reviewer adapter, implemented separately in Milestone 2.3B (below), and an auto-commit gate that can act on an approved review (Milestone 2.4).

Exit: domain/persistence/engine/FakeReviewer/API/isolation/browser tests pass; no real Claude CLI, Anthropic API, or other provider is invoked; no automatic commit/merge/push/retry occurs.

### Milestone 2.3B — Claude CLI reviewer adapter

- **Implemented:** `ClaudeCapabilityDiscovery` (`packages/relay-v2-claude-reviewer`), capability-validated exactly like `CodexCapabilityDiscovery` — every capability (print/output-format/json-schema/tools/safe-mode/strict-mcp-config/no-session-persistence/disable-slash-commands support, version, authentication status) is derived from the actual local `--help`/`auth status --json` output, never assumed. Safe executable resolution: `RELAY_V2_CLAUDE_PATH` override, `claude.exe`/`claude` directly on PATH, then (Windows only) static text parsing — never execution — of an npm `claude.cmd`/`claude.ps1` shim to recover the real binary it references.
- **Implemented:** a real `ClaudeCliReviewer implements RelayReviewer`, registered alongside `FakeReviewer` in `ReviewEngine`. `PRODUCTION_REVIEWER_ID_BY_SELECTION` maps `CLAUDE -> "claude-cli"`; it is authorized only as an explicit, capability-validated, task-approved reviewer (approval status `APPROVED`, reviewer selection `CLAUDE` unchanged since approval, requested reviewer id `claude-cli`) — see `resolveReviewerAuthority`.
- **Implemented:** no workspace, no tools (`--tools ""`), no MCP (`--strict-mcp-config`), no hooks/plugins/CLAUDE.md/session-persistence (`--safe-mode`, `--no-session-persistence`, `--disable-slash-commands`) — Claude receives only the sanitized, bounded, deterministically-serialized `ImmutableReviewCapsule` through stdin, rendered inside an explicit anti-prompt-injection policy header with clearly delimited evidence boundaries, run inside a disposable bundle outside the Relay repository (hashed before and after; any mutation becomes `ERROR`, never a trusted verdict).
- **Implemented:** structured output via `--json-schema` (JSON Schema enforcement) with defensive stdout parsing (`parseClaudeVerdict`) that never invents a verdict from ambiguous, malformed, or duplicate JSON output, and `reviewedRequestHash` is required to match exactly; `ReviewEngine`'s own `structuredReviewVerdictSchema` cross-field invariants are re-applied regardless of what the model produced.
- **Implemented:** live re-verification immediately before every real invocation — executable identity hash and version must match what was bound into the request at request time, and authentication status must be `AUTHENTICATED` at that exact moment; a stale, drifted, unsupported, or unauthenticated CLI can never produce an AUTHORITATIVE verdict. Relay does not depend on Claude availability: FakeReviewer and Codex execution remain fully functional with Claude absent, and `claude-cli`'s own diagnostics fail closed (SKIPPED/rejected, never a fabricated success) when the CLI is missing or unauthenticated.
- **Implemented:** a reviewer-agnostic `ReviewerCapabilityDiagnostic`/`ReviewerCapabilitySnapshot`/`ReviewEngine.refreshReviewerCapabilities`/`latestReviewerCapability` mirroring `ExecutionEngine`'s existing executor-capability pattern, and an append-only `ReviewInvocation` forensic record (reported by the reviewer through a new optional `ReviewControls.recordInvocation` callback, persisted only by `ReviewEngine` — a reviewer never touches the database directly) capturing process identity/exit/timing and redacted, bounded stdout/stderr/structured-output.
- **Implemented:** one new forward-only migration (`20260805000000_milestone23b_claude_reviewer`) rebuilding `ReviewRequest` to widen its `reviewerId` CHECK constraint from the Milestone 2.3A hard pin (`'fake-reviewer'` only) to also allow `'claude-cli'`, preserving every row/index/trigger, plus the two new tables above. No previously committed migration was edited.
- **Implemented:** a test double (`RELAY_V2_CLAUDE_TEST_DOUBLE` + `PROJECT_RELAY_TEST_MODE` + the disposable `playwright-v2` data directory, mirroring the existing Codex test-double gate exactly) that runs through the real `ClaudeCliReviewer` code path with only the process itself doubled, and an opt-in real-CLI smoke (`RELAY_V2_REAL_CLAUDE_REVIEW_SMOKE=1` / `npm run smoke:v2:claude-reviewer`) built and tested against process doubles only, per this implementation session's own restriction against a second real generative Claude turn.
- **Not implemented:** an auto-commit gate that can act on an approved review — unchanged from Milestone 2.3A, `commitAuthorityEligible` and `canSatisfyAuthoritativeReviewGate` unconditionally return `false`/deny regardless of `reviewAuthority`. That remains Milestone 2.4.

#### Milestone 2.3B corrective pass

An independent Codex security review of the implementation above returned **REJECT** (two blockers, five high-risk findings, three test gaps). Corrected in this pass, without recreating the milestone from scratch:

- **B1 — insufficient evidence:** `ReviewInputCapsule` now carries actual bounded/redacted evidence content (Git diff, changed-file status, verification stdout/stderr, task constraints/acceptance criteria, an execution artifact manifest), not merely hashes of it; a deterministic `ReviewMaterialManifest` records exactly what was included, omitted, or truncated and why.
- **B2 — verdict not bound to material/prompt:** `reviewMaterialHash`/`promptHash` are computed and persisted before the process is spawned; the verdict must echo both (plus `reviewedRequestHash`), independently re-verified before acceptance.
- **Strict wrapper/verdict parsing:** the Claude CLI transport wrapper is modeled exactly (based on this repository's own verified `stream-json` `result`-event shape) and parsed strictly — no Markdown-fence stripping, no prose-surrounded-JSON recovery, no picking between duplicate objects.
- **Native executable validation:** `RELAY_V2_CLAUDE_PATH` no longer authorizes an arbitrary file — the resolved candidate must be canonical, absolute, a regular non-empty file with the expected basename, and (Windows) a structurally valid native PE image.
- **Capability atomicity:** every capability flag the real invocation relies on is mandatory (UNKNOWN never treated as supported); the snapshot id/diagnostic-content pairing is read from one atomic query (closing a race in the original two-query implementation); a live capability-set drift (not just identity/version) blocks a review.
- **Diagnostics redaction:** sanitized display paths never leak a raw absolute path, drive root, username, or organization/project folder name.
- **`ReviewInvocation` lifecycle:** now a lease-owned lifecycle (`PREPARING` through a terminal status) durably coupled to heartbeat/ownership — heartbeat loss aborts the owned process, and a runtime-restart-recovered non-terminal invocation quarantines its execution session from a new authoritative request instead of being silently forgotten.
- **Migration atomicity:** the `ReviewRequest` rebuild is wrapped in an explicit transaction (sqlite.org's documented atomic-ALTER-TABLE recipe); migration tests now prove both a data-preserving upgrade from a seeded 2.3A review graph and a full rollback on a deliberately injected mid-migration failure, via the real `prisma migrate deploy` path.
- **Test gaps closed:** Claude diagnostics GET/POST route tests; migration tests seeding and verifying FakeReviewer data through the 2.3B rebuild; a browser suite driving the authoritative Claude test-double end to end (approve, reject with blocking findings, cancellation).

See `docs/CLAUDE_REVIEWER.md`, `docs/REVIEW_ENGINE.md`, and `docs/SECURITY.md` for full detail.

Exit: review lifecycle and context-minimization tests pass against the real adapter (`packages/relay-v2-claude-reviewer/src`, `packages/relay-v2-reviewer/src`, `packages/relay-v2-persistence/src`, isolation tests, all under `vitest.v2.config.ts`); real CLI smoke is built, tested with doubles, and left as an explicit operator opt-in (`npm run smoke:v2:claude-reviewer` from a separate terminal) rather than run generatively inside this implementation session.

#### Milestone 2.3B third corrective pass

A subsequent focused Codex review of the corrected implementation again returned **REJECT** (one blocker, three high-risk findings, plus a test gap). Fixed in this pass, without recreating the milestone or broadening scope beyond these findings:

- **B1 — evidence still not fail-closed:** persisted Git/verification evidence is now validated against strict `.strict()` Zod schemas mirroring the actual production writers (`workspace-evidence.ts`'s `GitEvidence`/`GitEvidenceDelta`, `verification-catalog.ts`'s `VerificationResult`, now carrying its own self-referential `resultHash`), including self-hash re-verification, PASS-with-nonzero-exit rejection, duplicate/conflicting changed-path rejection, and traversal-path rejection (`AUTHORITATIVE_EVIDENCE_POLICY` in `review-binding.ts`). Byte-level artifact validation (`artifact-evidence.ts`) independently re-reads every required `ExecutionArtifact` (execution log, final Git evidence, verification results) from the application-owned artifact store and re-verifies ownership, bound-set membership, canonical path containment, byte count, and SHA-256 before it is trusted as evidence — both at request time and again at pre-verdict revalidation.
- **H1 — heartbeat exceptions didn't abort the process:** a heartbeat call that throws is now caught and routed through the same idempotent ownership-loss guard as a `false` return, aborting the owned process either way.
- **H2 — no durable PREPARING → RUNNING transition:** `ReviewInvocation` now CAS-transitions to `RUNNING` the instant the real process starts, persisting the real process identity, instead of staying `PREPARING` for the entire process lifetime.
- **H3 — wrapper contract/parser version not durably bound:** `wrapperContractId`/`wrapperParserVersion` now flow through capability snapshot, diagnostic, semantic hash, persisted capability row, reviewer config, config hash, and `ReviewInvocation`, with an independent live re-check before every spawn.
- **T1 — FK migration test modified the migration itself:** the foreign-key regression test now seeds a genuine orphan `ReviewRequest` directly in an unmodified 2.3A database (foreign keys disabled on one setup connection only) and runs the unchanged, checked-in 2.3B migration against it.

See `docs/CLAUDE_REVIEWER.md`'s third corrective-pass note, `docs/REVIEW_ENGINE.md`'s "Eligibility"/"Milestone 2.3B migration" sections, and `docs/SECURITY.md`'s corresponding entry for full detail.

#### Milestone 2.3B fourth hardening pass

A completion report following the third corrective pass explicitly listed three remaining known limitations, closed in this pass ahead of the next independent review, without redesigning the milestone or broadening scope beyond these three items:

- **Artifact-store requirement made a real assertion for AUTHORITATIVE review, not a silently-skippable condition.** `ReviewEngine.checkEligibility`'s prior gate — a bare `if (session.executorId === "codex-cli" && this.artifactsRoot)` — silently skipped byte-level artifact validation whenever `artifactsRoot` was unset, rather than blocking. `ReviewEngine.validateAuthoritativeArtifactEvidence` replaces it, keyed on the *resolved* `reviewAuthority` (not the executor id) and enforced at three points: `requestReview` (before any `ReviewRequest` row exists — the reviewer is never invoked), a live pre-spawn re-check inside `runClaimed` (immediately before the `ReviewInvocation` row is created and `reviewer.review()` is ever called — catches a store that becomes unreadable *after* the request but *before* the run), and `revalidateForVerdict` (before verdict acceptance). Absence or a read/hash-validation failure is always `ERROR` (`failureCode: "ARTIFACT_STORE_UNAVAILABLE"`/`"ARTIFACT_STORE_READ_FAILURE"`), never `STALE` — distinguishing a configuration/I/O problem from ordinary evidence drift. Never falls back to database metadata or a live workspace read. A DIAGNOSTIC review (FakeReviewer) has no such requirement.
- **A central, coordinated `AuthoritativeReviewMaterialBudget`** (`packages/relay-v2-domain/src/review.ts`) replaces a set of independent, uncoordinated per-field caps (`MAX_DIFF_PREVIEW_CHARS`, `MAX_STREAM_PREVIEW_BYTES`, `MAX_ARTIFACT_BYTES`, `maximumInputBytes`) with one explicit, versioned structure covering an aggregate original/included-byte ceiling, a maximum artifact count, a maximum per-artifact size, a maximum prompt/final-stdin size, and per-category `maxOriginalBytes`/`maxIncludedBytes` for every evidence category named in the hardening request (approved spec, Git diff/patch, changed-file metadata, verification stdout, verification stderr, execution log, execution summary, artifact manifest, reviewer policy/prompt framing). `assertWithinMaterialBudget` (`review-binding.ts`; **superseded by the fifth corrective pass's exact serialized ledger, below**) computed deterministic UTF-8 byte accounting directly from the already-built `ReviewInputCapsule` (fail-closed on any non-safe-integer byte count; a duplicate `(artifactType, relativePath)` manifest entry is rejected outright by the capsule schema itself, so no category can evade the total by splitting content across many artifacts), enforced by `ReviewEngine` at request time (before any row exists) and revalidation (before verdict acceptance), plus an independent final check on the exact rendered stdin bytes (`assertPromptWithinBudget` in `review-material.ts`) immediately before the reviewer CLI is spawned. `budgetVersion` is bound into `ClaudeReviewerConfig.materialBudgetVersion` and therefore `reviewerConfigHash`/`requestHash`.
- **An explicit, enforced, three-tier category truncation policy** (`EVIDENCE_CATEGORY_TRUNCATION_POLICY`, `review-binding.ts`) turns the previously documentation-only `AUTHORITATIVE_EVIDENCE_POLICY` into real enforcement: `NON_TRUNCATABLE_CRITICAL` (approved spec, constraints, acceptance criteria, verification requirements, changed-file list, artifact manifest, execution summary — never truncated in practice, since an oversized value is a hard schema-parse failure, never a silent cut), `TRUNCATABLE_CRITICAL_WITH_DISCLOSURE` (Git diff, verification stdout/stderr — truncatable only when proven safe), and `OPTIONAL` (execution log — always truncatable, always disclosed, never blocks). `checkFinalDiffTruncationCoverage` blocks a truncated final diff that no longer evidences every changed file; `checkVerificationTruncationSafety` blocks a **failed** verification operation whose truncated stdout/stderr cannot be proven to preserve its failure-relevant tail (the upstream `verification-catalog.ts` truncation is head-only); `checkCriticalRedactionCollapse` blocks a non-truncatable-critical free-text field that collapsed to near-nothing under secret redaction. Every material-manifest entry now discloses `truncationMethod` and `omittedByteCount` alongside the pre-existing `originalByteCount`/`includedByteCount`/`contentHash`/`truncated`.
- **The validated `LOG` artifact's real bytes now actually reach Claude.** `artifact-evidence.ts`'s byte-level validation always read and hash-verified every required artifact's content, but every prior caller discarded the returned bytes, keeping only a pass/fail result — no evidence category's actual artifact-file content was ever consumed by the review pipeline, and `LOG` (the execution's own event transcript) had no other representation in the material at all (only its hash/path/byte count, with an explicit "bytes are not read or transmitted" `omissionReason`). `validateRequiredArtifacts` now also returns the `LOG` artifact's exact validated `Buffer`; `ReviewEngine.buildReviewInputCapsule` embeds it (head+tail bounded, disclosed) into a new `executionLogEvidence` capsule field, and `review-material.ts` renders it as `material.executionLog` with a real, non-omitted manifest entry. The same `Buffer` from one atomic validation call is what gets embedded — never re-read a second time — closing the immutable-validated-byte gap for the one category where it mattered; `FINAL_GIT`/`BASELINE_GIT`/`PATCH`/`VERIFICATION` artifact files remain provenance-only in the manifest, since their on-disk content is redacted at write time while the equivalent, already self-hash-verified DB-JSON evidence (redacted at render time) is what already populates the capsule — a byte-for-byte cross-check between the two would produce false-positive mismatches from redaction-timing skew alone, not real tampering.
- Pre-verdict revalidation (`revalidateForVerdict`) requires no separate wiring for any of the above: it already rebuilds the full capsule fresh and requires its `requestHash` to match bit-for-bit before accepting a verdict, so a budget/truncation-policy violation or artifact-store failure introduced between request and verdict is caught by the same existing mechanism. No Prisma migration: every new field lives inside the existing `reviewInputJson`/`reviewerConfigJson` JSON columns.

45 new/extended tests across `artifact-evidence.test.ts`, `review-binding.test.ts`, `review-engine.test.ts` (unchanged), `review-invocation-lifecycle.test.ts`, and `review-material.test.ts` (claude-reviewer package) — including an end-to-end test that mutates the on-disk `LOG` artifact between an accepted request and its pre-verdict revalidation and confirms the mismatch is caught (`ERROR`, no verdict persisted, and the material actually rendered to the reviewer reflected the original, pre-mutation bytes).

See `docs/CLAUDE_REVIEWER.md`'s "A fourth independent corrective pass" and "Central material byte budget enforcement", `docs/REVIEW_ENGINE.md`'s "Eligibility", `docs/SECURITY.md`'s corresponding entry, and `docs/TROUBLESHOOTING.md` for full detail.

#### Milestone 2.3B fifth corrective pass

A further independent review rejected the fourth pass on three blockers and one high-risk finding, closed here without redesigning the milestone or broadening scope:

- **B1 — Git and verification content rendered to Claude was not cryptographically tied to the validated artifact bytes.** The fourth pass validated artifact bytes and then discarded them for every category except `LOG`, rendering the review from database JSON that vouched for itself with its own embedded hash. A self-hash inside mutable JSON proves nothing against an actor who can write that JSON, because the hash is simply recomputed after the edit. This pass makes the **artifact bytes the authoritative source**: strict, versioned artifact contracts (`packages/relay-v2-domain/src/evidence-artifacts.ts`) for `FINAL_GIT`, `PATCH`, `CHANGED_FILES`, `VERIFICATION`, and `LOG`; a full read → ownership/membership → containment → byte-count → SHA-256 → strict-decode → strict-parse → canonicalize → semantic-hash chain; and a required **canonical semantic equality** between the parsed artifact and the database projection (`checkArtifactDatabaseEquality`). Divergence in *either* store blocks before any reviewer process is spawned. The contracts live in the domain package so producer and consumer are bound to one definition, not two copies that drift. `PATCH`/`CHANGED_FILES` are now **conditionally required** from what the Git evidence itself says, with an explicit empty changed-file artifact required for a run that changed nothing, full patch coverage of every changed file (or an explicit policy-approved omission), and rejection of conflicting statuses, duplicate normalized paths, and a baseline patch standing in for a final one.
- **B2 — Material-budget accounting did not cover the exact serialized content, policy prompt, or final stdin.** Field-level `Buffer.byteLength` approximation is replaced by an **exact serialized byte ledger** (`material-ledger.ts`), built by `buildReviewMaterialSections` in the same pass that builds the material, whose rows compose the material exactly once. Section sizes are measured by running the real serializer over the real rendered values, so property names, quotes, commas, brackets, escaping, and previously uncounted fields (task context, verification requirements, per-operation summaries, the manifest, and the reviewer policy prompt — which had a declared limit and was counted as literally `0`) are all charged. The prompt and stdin are built **once** and measured from the built strings; `maxPromptBytes` and `maxFinalStdinBytes` are enforced independently, so a prompt one byte over its own ceiling is rejected while still under the stdin ceiling. The ledger's policy version and canonical hash are bound into `ReviewRequest` (covered by its immutable-payload trigger) and into `ReviewInvocation` alongside `finalStdinHash` and the exact `promptAccountingJson`, and are reconstructed and required to match before any verdict is accepted.
- **B3 — Truncation provenance was inaccurate, and producer-truncated critical artifacts could still authorize a review.** Every original/included/omitted count and full-content hash is now computed at write time from the **complete** content, before the cut — never back-inferred from the shortened result. `producerTruncationSchema` cannot express "nothing was lost" and "bytes are missing" at once, nor `producerTruncated: true` with a zero omission; an upstream capture that lost an unknown amount is reported as a distinct `captureTruncated` flag rather than a fabricated count. Producer-truncated `FINAL_GIT`/`PATCH`/`CHANGED_FILES`/`VERIFICATION` now **blocks** an AUTHORITATIVE review, and the reviewer never attempts to reconstruct missing source content; `LOG` keeps its explicit optional/truncatable policy. Reviewer-side truncation is a separate, disclosed concept that happens only after complete bytes are validated.
- **H1 — LOG decoding was permissive.** Authoritative evidence is decoded with `TextDecoder` in `fatal` mode (`text-safety.ts`), rejecting invalid UTF-8, NUL bytes, disallowed C0/C1 control bytes and DEL, binary content, and a leading BOM. Hashes are taken over the **original raw bytes**, never a decoded/re-encoded string. Truncation redacts first, measures, then cuts only on complete Unicode code-point boundaries — never a `Buffer` slice that can split a multibyte sequence or surrogate pair — charges the omission marker against the budget first, and reports omitted bytes against the complete redacted source.

Persistence: `ExecutionArtifact` gains `schemaVersion`/`fullContentSha256`/`originalByteCount`/`omittedByteCount`/`truncationMethod`; `ReviewRequest` gains `materialBudgetPolicyVersion`/`materialBudgetLedgerJson`/`materialBudgetLedgerHash` (all three added to the immutable-payload trigger); `ReviewInvocation` gains `materialBudgetLedgerHash`/`finalStdinHash`/`promptAccountingJson`. The still-uncommitted 2.3B migration was updated in place; no committed migration was touched.

709 v2 tests pass (up from 627), including new suites for strict UTF-8 and code-point-safe truncation (`text-safety.test.ts`), cross-store divergence in both directions (`artifact-database-equality.test.ts`), conditional patch/changed-file requirements and producer-truncation blocking (`artifact-evidence-required.test.ts`), the exact byte ledger and prompt/stdin boundaries, and end-to-end finalization reconstruction.

See `docs/CLAUDE_REVIEWER.md`, `docs/REVIEW_ENGINE.md`'s "Canonical evidence artifact contracts"/"The artifact-to-database equality chain"/"Finalization reconstruction", `docs/EXECUTION_ENGINE.md`'s "Canonical, versioned evidence artifacts"/"Truthful producer truncation provenance", `docs/SECURITY.md`, and `docs/TROUBLESHOOTING.md` for full detail.

#### Milestone 2.3B sixth corrective pass

A further independent review rejected the fifth pass on three blockers and three high-risk findings. Each one was a gap between a check and the thing the check was about; all are closed here without redesigning the milestone or broadening scope:

- **B1 — Verification runner-level output loss could be recorded as complete.** `SafeProcessRunner` counts every byte a process writes but stops **forwarding** once its combined cap is reached, reporting `outputTruncated`/`stdoutBytes`/`stderrBytes` on the exit event; `VerificationCatalogRunner` read only `exitCode`. A run whose output was discarded could therefore persist as an empty captured stream, `captureTruncated: false`, and `PASSED`. Those runner figures now propagate into per-stream `StreamCaptureProvenance` (`stream-capture.ts`) with a closed byte chain (`raw → delivered → captured → included`) and an explicit `COMPLETE`/`TRUNCATED_KNOWN`/`TRUNCATED_UNKNOWN` completeness; `SafeProcessRunner` reports each chunk's raw size so redaction is distinguishable from discarded output, and where attribution genuinely is not knowable it is recorded as unknown rather than resolved favourably. An empty capture with nonzero raw bytes cannot be `LEGITIMATE_EMPTY`, a complete-stream hash is never fabricated from a surviving fragment, and `TRUNCATED_UNKNOWN` **blocks** an AUTHORITATIVE review regardless of exit status (`checkVerificationCaptureCompleteness`).
- **B2 — The ledger did not measure the envelope actually transmitted.** It summed separately serialized fragments while a different object was sent (outer framing, nested framing, property names, separators, escaping, `requestHash`), and the manifest and ledger were hashed into the binding but never placed inside the material Claude could read. There is now one versioned transmitted value, `ReviewMaterialEnvelopeV1 { schemaVersion, core, ledger }` (`material-envelope.ts`), built strictly in order — core, then ledger measured from that exact core, then envelope, then **one** canonical serialization — so the ledger is non-self-referential by construction. `maxTotalIncludedBytes` is enforced against `exactMaterialEnvelopeByteCount` (the exact UTF-8 size of the complete canonical envelope), `outerFramingByteCount` reconciles the section rows with the measured whole, `reviewMaterialHash` is taken over those exact bytes, and the manifest, provenance disclosure, and ledger are inside what the reviewer receives. `REVIEWER_POLICY_PROMPT` carries its exact byte count, never zero.
- **B3 — Finalization did not independently reconstruct the transmitted identity.** `PreparedClaudeReviewInvocation` is now built once, before any process exists, and its complete identity (envelope version, budget policy version, ledger JSON/hash, `reviewMaterialHash`, exact envelope byte count, prompt policy version, `promptHash`, prompt/stdin byte counts, `finalStdinHash`, prompt accounting) is persisted on the `PREPARING` `ReviewInvocation` row in the same transaction that proves ownership — and is **write-once** at the database level. The reviewer sends those exact bytes and builds nothing of its own. At finalization the engine rebuilds capsule, envelope, ledger, prompt, and stdin from current evidence and compares field by field (`compareInvocationIdentity`), then requires Claude's echoed hashes to match that reconstruction rather than its own input. Evidence drift is `STALE`/`EVIDENCE_CHANGED`; a mismatched binding or echo is `ERROR`/`INVOCATION_BINDING_MISMATCH`/`REVIEWER_ECHO_MISMATCH`. Nothing reruns.
- **H1 — LOG producer provenance and NDJSON validation were incomplete.** `appendLog` now writes a complete record or none at all (the byte cap previously stored a fragment of one), and `finalizeLog` emits a versioned `LogProvenance` (complete-stream hash, byte counts, record counts, completeness) persisted verbatim in `ExecutionArtifact.provenanceJson` and carried to the reviewer unchanged, cross-checked against the real bytes. Every included record must parse as exactly one schema-valid JSON object; a partial trailing line, a JSON array, a bare scalar, or an unknown record shape is refused. Reviewer-side bounding drops whole records only, and its omission marker is itself a valid record, so a bounded transcript is still complete NDJSON.
- **H2 — Patch coverage used substring matching.** `unifiedDiff.includes(path)` counted a filename appearing anywhere — including inside another file's hunk body — as coverage. Coverage now comes from a strict header parser (`unified-diff.ts`): `diff --git a/… b/…`, `---`/`+++` (with `/dev/null`), and `rename from`/`rename to` only, with separators normalized, and malformed headers, quoted paths, absolute/traversal paths, and duplicate conflicting blocks all refused. Hunk bodies are never inspected for paths. The same parser runs on the producer (`buildPatchArtifact`), inside the `PATCH` schema, on the database projection, and at reviewer coverage-check time. Relay's composite staged/unstaged capture has explicit shared section markers so consumers split before parsing.
- **H3 — Pre-spawn validation checked current artifacts but invoked Claude with the older persisted capsule.** `runClaimed` now rebuilds the complete current binding — capsule, `reviewInputHash`, `requestHash`, envelope, ledger, prompt, stdin — and requires it to reproduce the request's identity **before** the invocation row is created. Evidence rewritten *coherently* after the request (both stores valid, self-hashes recomputed) is caught here: `STALE`, no invocation row, no reviewer call, no process. Claude is never knowingly run against a binding whose verdict would have to be discarded.

Persistence: `ExecutionArtifact` gains `provenanceJson`; `ReviewInvocation` gains `materialEnvelopeVersion`/`materialBudgetPolicyVersion`/`materialBudgetLedgerJson`/`exactMaterialEnvelopeByteCount`/`finalPromptByteCount`/`finalStdinByteCount` plus a new `ReviewInvocation_immutable_material_identity` write-once trigger. The still-uncommitted 2.3B migration was updated in place; no committed migration was touched, and the unique-per-request constraint, append-only/immutable authority fields, ownership lifecycle, and FK rollback guarantees are unchanged.

807 v2 tests pass (up from 709) and 11/11 browser tests, including new suites for runner-level output loss (`verification-runner-loss.test.ts`), the exact unified-diff header parser (`unified-diff.test.ts`), NDJSON log records and provenance (`log-records.test.ts`, `log-provenance.test.ts`), the transmitted envelope and prompt/stdin identity (`review-material.test.ts`), and pre-spawn coherent drift plus finalization identity tampering (`review-invocation-lifecycle.test.ts`).

See `docs/CLAUDE_REVIEWER.md`'s "The transmitted material envelope"/"Immutable preparation, built exactly once", `docs/REVIEW_ENGINE.md`'s "Pre-spawn full reconstruction, and engine-owned finalization reconstruction", `docs/EXECUTION_ENGINE.md`'s "Runner-boundary output loss is propagated, never discarded"/"The execution LOG is record-structured", `docs/SECURITY.md`, and `docs/TROUBLESHOOTING.md` for full detail.

#### Milestone 2.3B: Claude CLI 2.1.221 support

The locally installed CLI moved to 2.1.221, which the exact contract catalog correctly refused — the real smoke returned SKIPPED. Support was added the only way the catalog permits: by observing the actual wrapper first.

- **A diagnostic-only unregistered-version mode** (`unregistered-version-diagnostic.ts`), reachable solely from the standalone smoke harness behind all three of `RELAY_V2_REAL_CLAUDE_REVIEW_SMOKE`, `RELAY_V2_CLAUDE_SMOKE_DIAGNOSTIC`, and `RELAY_V2_CLAUDE_ALLOW_UNREGISTERED_DIAGNOSTIC`. It takes no database (so it cannot create a `ReviewRequest` or `ReviewVerdict`), never constructs a `ClaudeCliReviewer` (so it produces no verdict), never marks a version supported, never writes to the frozen catalog, refuses when the CLI is unsupported for any reason *other* than being unregistered, uses the identical read-only argv and disposable bundle a real review uses against a synthetic capsule, and terminates as `DIAGNOSTIC_ONLY` — there is no code path returning `PASSED`.
- **A contract comparator** (`wrapper-contract-comparison.ts`) reporting top-level key set, per-field types, exact authority-field literals, `result`/`structured_output` parse and canonical equality, hash echo, and whether the unchanged production parser accepts the output.
- **The comparator was corrected before registration.** It originally inferred expected field types from the fixture's *values*, so a valid `fast_mode_disabled_reason: "…"` read as a contract violation because the sample carried `null` there. Expected types now come from `CLAUDE_WRAPPER_CONTRACT_FIELDS` — explicit metadata beside the schema, declaring `string | null` for `fast_mode_disabled_reason`/`stop_reason`/`terminal_reason` — and a drift test probes the real schema with a representative value of every JSON type for every field and requires exact agreement. Authority fields stay exact; `.strict()` unknown-field rejection is unchanged.
- **2.1.221 registered** with the same `contractId`/`parserVersion` as 2.1.220, after the operator's diagnostic proved the wrapper identical. `2.1.222` and every unobserved version remain unsupported; matching stays exact (no ranges, prefixes, or `>=`), and the two versions keep distinct capability semantic hashes, so a request bound under one cannot run under the other.

879 v2 tests pass (up from 815) and 11/11 browser tests.

### Milestone 2.4 — auto-commit gate (planned)

- Define the policy under which an `APPROVED` review verdict may authorize a commit (and only a commit — not merge/push/deploy) of the reviewed execution's changes.
- Extend, not replace, the evidence-binding and staleness-recheck model from Milestone 2.3A: a commit must be bound to the exact reviewed evidence, not merely to a review ID.

Exit: commit-authorization tests prove no commit occurs without a current, non-stale `APPROVED` verdict bound to unchanged evidence.

### Milestone 4 — memory engine

- Implement context snapshots, decisions, issues, verified memory entries, evidence links, reviewable memory candidates, and generated-document revisions.
- Generate `PROJECT_STATE.md`, `DECISIONS.md`, `OPEN_ISSUES.md`, and `HANDOFF.md` deterministically from accepted database state.
- Import existing `.ai-project` content as attributed unverified candidates unless evidence proves it.

Exit: deterministic generation, no-overwrite, verification, attribution, and rollback tests pass.

### Milestone 5 — optional Gemini and DeepSeek orchestration

- Implement secure credential-store integration and provider-neutral `OrchestratorProvider` methods.
- Implement disabled-by-default configurations, connection tests, deterministic fallback, transmission preview, METADATA_ONLY default, explicit source approval, selected/full approved modes, payload limits, and response Zod validation.
- Gemini: multimodal/document/structured extraction only. DeepSeek: planning/summarization/aggregation only. Neither is a coding executor.

Exit: all behavior works with providers disabled or failing; mock contract tests pass; real API tests are opt-in and never expose keys.

### Milestone 6 — MCP and ChatGPT integration

- Verify current official MCP and OpenAI App documentation before choosing SDK/API examples.
- Implement the requested tools, schemas, auth/rate-limit hooks, idempotency, audit, read/write distinction, and clear errors.
- `relay_create_task` requires an idempotency key, creates `PENDING_APPROVAL`, audits, returns structured data, and has no path to execute.
- `relay_cancel_task` may request cancellation but cannot perform an unrelated dangerous operation.

Exit: MCP validation/idempotency/approval-boundary tests pass and manual local setup is documented.

### Milestone 7 — remote bridge

- Design only until explicitly approved after the local workflow is stable.
- No inbound port, cloud source storage, remote execution, or secret transfer.

## 14. Testing strategy

### 14.1 Test layers

**Pure domain tests**

- handoff schema and readable error paths;
- task status transition matrix and invalid transitions;
- classification/routing/effort/reviewer rules;
- approval and dangerous-operation scope/hash/expiry;
- retry/escalation recommendations;
- command risk classification;
- transmission policy and model-output Zod validation;
- memory verification and document projection.

**Persistence integration tests**

- one temporary SQLite database per test worker or suite;
- foreign keys, unique idempotency, duplicate concurrency, work claiming, leases, crash recovery, audit immutability, and migration mappings;
- WAL/busy-timeout contention and ordered execution events;
- no tests point at a non-disposable data path.

**Workspace/process integration tests**

- temporary real Git repositories;
- absolute/canonical path checks, traversal, symlink/junction, case variation, UNC behavior where available, secret-file denial;
- process incremental stdout/stderr, split-secret redaction, output limits, timeout, cancellation, process-tree termination, and non-zero exit truthfulness;
- workspace lock contention/recovery;
- Git pre/post checkpoint, dirty baseline, changed files, large/binary diff artifacts, and checksum verification.

**Adapter contract tests**

- recorded sanitized help/stream fixtures for supported CLI versions;
- executable discovery and unsupported flag/model/effort behavior;
- malformed JSON/JSONL, missing terminal event, provider-declared failure with exit zero, stale resume, cancellation, and timeout;
- real CLI tests are opt-in and must report `SKIPPED: executable unavailable`, `SKIPPED: not authenticated`, or the observed failure. Never fake a pass.

**Web/UI tests**

- import/paste/file/manual validation and preview;
- create produces `PENDING_APPROVAL` only;
- selected settings are included in approval hash;
- live SSE reconnect/cursor behavior;
- cancel/retry/review/accept/reject actions;
- diff/results, transmission preview, memory approval, diagnostics, audit log;
- loopback, CSRF, local identity, and project access on every route.

**MCP tests (Milestone 6)**

- exact JSON schema validation, auth hook, rate-limit hook, idempotency, duplicate response, error shape, read/write distinction, audit event, and inability to start execution.

### 14.2 Required named coverage

The implementation must include automated coverage for every requested area: handoff validity/errors, task creation, idempotency/duplicates, transitions, approval enforcement, model routing, provider fallback, risk, redaction, path validation, locking, timeout, cancellation, Git checkpoint/diff, API transmission, MCP input, and MCP approval boundaries.

### 14.3 Verification commands and reporting

Each milestone should run the narrow tests first, then typecheck, lint, relevant integration tests, and build. Browser E2E runs against a disposable SQLite/data directory. Real CLI/API checks remain separate opt-in smoke commands. Reports list:

- exact command;
- pass/fail/skip and reason;
- environment prerequisites;
- changed files;
- known limitations;
- whether application behavior was actually exercised.

`docs/SMOKE_TEST.md` will contain the manual checklist and distinguish implemented, tested, partial, and planned behavior.

## 15. Rollback strategy

### 15.1 Source control

- Use the recorded baseline commit above and create a milestone branch only after plan approval.
- Keep changes small and milestone-scoped. Do not commit until the user reviews results.
- Never include the pre-existing `apps/web/next-env.d.ts` or `.claude/` changes in a Relay commit.
- Roll back with a normal revert or by disabling the milestone feature flag; never force-push, reset hard, rewrite history, or delete the legacy implementation.

### 15.2 Data

- Milestone 1 creates a new SQLite file; it does not convert PostgreSQL in place.
- Before import, record PostgreSQL schema version, table counts, selected relationship counts, and export/checksum metadata. Create an approved database backup using the existing database's native tooling.
- Import in a repeatable transaction and retain an `ImportReport`/audit record. A failed import deletes only the newly created disposable/import database after its exact path is verified; it never touches the PostgreSQL source.
- Before each SQLite migration, stop the v2 runtime and make an app-owned timestamped copy using SQLite's safe backup mechanism.
- Keep the old Compose configuration and volume until the user explicitly accepts v2 data and the rollback window.

### 15.3 Runtime cutover

- Use mutually exclusive flags for `legacy` and `v2` execution authority.
- Drain/terminalize legacy jobs, stop the worker, verify no owned provider process remains, then enable the SQLite runtime.
- If v2 fails, stop it, restore the previous SQLite backup if needed, disable v2, and restart the unchanged legacy web/worker/PostgreSQL/Redis path.
- Never let both runtimes own write-capable work for the same project.

### 15.4 Workspace and memory

- Every write run gets a pre-run Git snapshot and patch artifact. Relay never discards a user's dirty changes.
- Generated memory documents are previewed and written by atomic replacement only after acceptance. Preserve the prior generated revision and hash.
- Existing `.ai-project` files are imported/read but not deleted or silently overwritten.

## 16. Open questions and assumptions

The plan proceeds with the recommended assumptions below unless the user changes them before the relevant milestone.

1. **Existing data migration.** Recommendation: import projects, tasks, criteria, decisions, evidence, sessions, findings, checkpoints, and audit history; preserve conversations as read-only legacy history. Starting with a blank v2 database is simpler but loses useful continuity.
2. **Pre-run Git checkpoint.** Assumption: this means an immutable Relay snapshot plus patch/hash artifacts, not an automatic Git commit, branch, tag, or stash. Any Git mutation needs a separate approved operation.
3. **Dirty worktree policy.** Recommendation: SAFE inspection is allowed; write execution is blocked by default when dirty until the user acknowledges the captured baseline. CRITICAL/DANGEROUS tasks should require a clean worktree unless an explicit policy exception is approved.
4. **Data directory.** Recommendation: `%LOCALAPPDATA%\Relay` for normal use and ignored `.relay-data` only for repository development/tests. Confirm whether portable mode is required.
5. **Legacy conversation UI.** Recommendation: keep it read-only during migration, remove its execute controls at v2 cutover, and decide on full retirement only after task handoff/MCP workflows are accepted.
6. **CLI source transmission.** Assumption: approving a Codex/Claude run approves the displayed, hashed execution capsule sent through that CLI. Gemini/DeepSeek source-bearing transmissions always receive a separate transmission preview/approval.
7. **Claude as executor.** Recommendation: Codex remains primary; Claude workspace-write is an explicit fallback, never an automatic response to one failure.
8. **Model catalog.** Recommendation: no marketing model names in business logic. Start with provider default (no model flag), locally discovered capabilities, and user-configured/probed catalog entries.
9. **Secure credential library.** Selection is intentionally deferred to a Windows-native Milestone 5 proof. Optional API providers remain disabled if secure OS storage is unavailable; there is no plaintext fallback.
10. **MCP transport and ChatGPT connectivity.** Choose stdio versus authenticated loopback/bridge behavior only after checking current official MCP/OpenAI guidance in Milestone 6. No execution-start tool will be exposed in either case.
11. **Docker support.** Assumption: Docker commands are optional, server-defined project operations. Image builds are REVIEW; container/database-destructive operations are DANGEROUS or BLOCKED according to target and arguments.
12. **Single-user boundary.** Assumption: milestones 1–5 remain one trusted local OS user on loopback. Multi-user/network access is out of scope; MCP still receives scoped authentication and audit hooks.

## Milestone 0 decision request

Approve this plan to begin Milestone 1 only, or request changes to the assumptions, data migration policy, target folder structure, SQLite cutover strategy, or task workflow. Approval of this document does not authorize Milestone 2 execution work, provider API use, MCP work, deployment, destructive operations, or a Git commit.
