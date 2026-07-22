# Database

PostgreSQL 17. Prisma schema and initial migration cover projects, tasks, criteria, decisions, capsules, sessions, events, evidence, checkpoints, memory updates, approvals, and audit events.

## Update — 2026-07-22T05:58:48Z
- What changed: Applied `20260722000000_init/migration.sql` directly in the disposable container; 12 public tables exist.
- Why: Verify the SQL while the local Prisma Windows schema-engine path is blocked.
- Task: bootstrap-mvp
- Agent: codex
- Evidence: psql ON_ERROR_STOP exit 0; information_schema table count 12
- Confidence: HIGH
