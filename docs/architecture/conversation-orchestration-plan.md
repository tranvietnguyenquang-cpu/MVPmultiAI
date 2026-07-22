# Conversation orchestration plan

## Compatibility boundary

Existing `Task`, `AgentSession`, evidence, review, and checkpoint records remain the task-execution compatibility layer. Conversations add a user-facing, provider-neutral timeline. A conversation message may reference a task and an existing agent session while new provider sessions remain conversation-scoped.

## Model and routing

`Conversation` owns the continuous chat. `ConversationMessage` records every user, assistant, system, and tool event with provider attribution. `ProviderSession` is provider-specific and never shared across providers. On a switch, the router persists a `RoutingDecision`, builds a versioned `HandoffCapsule`, and passes only the deterministic capsule to the target provider.

## Deterministic handoff

The builder orders objective, task, locked decisions, constraints, relevant files, baseline/diff summary, test status, unresolved issues, accepted findings, and latest checkpoint. It enforces a byte/token cap, records source-message bounds, and hashes canonical JSON. Raw historical messages are excluded unless explicitly selected.

## Execution and cancellation

The worker creates the user message before routing, then starts/resumes the selected provider session. Normalized events become tool messages; final output becomes one assistant message. Cancellation marks the execution/message/session terminal before killing only the tracked child-process tree, so late output is ignored.

## Checkpoints

A checkpoint captures the conversation boundary, relevant message IDs, latest handoff, Git baseline/status, tests, decisions, and unresolved issues. Resume creates a new provider session from the checkpoint capsule and checks repository staleness before execution.

## Verification lifecycle

The verification harness owns and records its web/worker process trees. It generates Prisma before startup, retries a lock only after confirming the lock holder is harness-owned, and tears down only tracked PIDs. Real provider/browser stages are reported separately from mocked regression coverage.
