# Decisions

- ADR-001 (accepted, locked): Git and captured command evidence outrank provider-generated summaries.
- ADR-002 (accepted): Browser submits command IDs; the worker resolves structured executable/argument allowlist entries and never executes browser-supplied shell text.
- ADR-003 (accepted): Provider, project-memory, execution, and context logic remain separate packages.

## Update — 2026-07-22T05:58:48Z
- What changed: Recorded initial architecture decisions.
- Why: Preserve safety and provider independence through future sessions.
- Task: bootstrap-mvp
- Agent: codex
- Evidence: docs/ARCHITECTURE.md; package boundaries
- Confidence: HIGH
