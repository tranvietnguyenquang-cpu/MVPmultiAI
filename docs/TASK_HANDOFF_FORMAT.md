# Relay Handoff v1

Status: YAML/JSON parsing, paste, clipboard read, file import, manual creation, normalization, preview, hashing, and pending-task creation are implemented in Milestone 1.

## Format

Every handoff is validated by the versioned Zod schema before it can be normalized or persisted.

```yaml
version: 1
project:
  name: WebManageSchool
  pathHint: C:\WebManageSchool
task:
  title: Repair tenant import coverage
  objective: Complete missing tenant import mappings and verify imported data.
  taskType: implementation
  complexity: complex
  context: Existing import covers core data but some modules remain incomplete.
constraints:
  - Do not modify production
  - Preserve database-per-school isolation
acceptanceCriteria:
  - Dry-run completes successfully
  - Relevant tests pass
execution:
  executor: codex
  model: auto
  effort: auto
  reviewer: claude
  requireApproval: true
  allowSourceTransmissionToApi: false
```

Required fields are `version`, `project.name`, `task.title`, `task.objective`, `task.taskType`, `task.complexity`, and at least one acceptance criterion. `version` must be `1`, and `execution.requireApproval` must be `true`.

Supported task types are `implementation`, `bugfix`, `documentation`, `analysis`, `migration`, `security`, `operations`, and `other`. Complexity is `trivial`, `normal`, `complex`, or `critical`.

Milestone 1 accepts executor `auto`, `codex`, or `claude`; effort `auto`, `low`, `medium`, or `high`; and reviewer `none`, `auto`, `codex`, or `claude`. A model is `auto`, `default`, or a bounded user-provided identifier. These selections are recorded for approval only; they do not invoke an executor.

## Safe parsing and limits

- JSON uses the native JSON parser.
- YAML uses the YAML 1.2 core schema with custom tags disabled, merge keys disabled, unique keys required, and aliases rejected.
- Maximum UTF-8 payload size is 262,144 bytes.
- Unknown fields are rejected.
- Parsed values are always validated by Zod; YAML cannot construct executable or custom objects.
- Likely API keys, bearer tokens, passwords, private keys, and credential-bearing database URLs are rejected before persistence.

Errors include human-readable nested paths such as `task.objective` or `acceptanceCriteria.0`. A validation-failure audit stores only bounded issues and payload byte size, never the submitted handoff body.

## Normalization and duplicate prevention

Before hashing, Relay:

- normalizes line endings;
- trims text;
- removes case-insensitive duplicate constraints and acceptance criteria while preserving order;
- converts domain selections to normalized values;
- writes keys in a stable canonical JSON order.

The SHA-256 normalized-spec hash is stored with the task and approval. Imported/external submissions accept an idempotency key; if omitted by a local import flow, Relay generates one. The UI uses the normalized spec hash for deterministic handoff imports. Database uniqueness prevents concurrent duplicate insertion, and a matching duplicate returns the existing task. Reusing a key or external ID for a different spec is a conflict.

Every manual, pasted, clipboard, YAML, JSON, or file-import creation path ends at `PENDING_APPROVAL`. Creating a task never approves, queues, or executes it.

Editing a pending or approved task creates a new hash, invalidates pending/approved approval records, and returns the task to `PENDING_APPROVAL` with a new approval request.

## UI workflow

Open `/v2/import` to paste or import a `.yaml`, `.yml`, or `.json` file. Use **Import from clipboard** when browser permission is available; if permission is denied, ordinary paste remains available. Validate first, review the normalized preview and hash, then create the pending task. **Copy template** copies the canonical template or places it in the text area if clipboard writing is unavailable.

