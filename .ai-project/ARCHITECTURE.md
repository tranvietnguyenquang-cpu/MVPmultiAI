# Architecture

Next.js App Router web/API process -> PostgreSQL via Prisma. BullMQ in Redis -> separate worker -> provider adapter and structured commands inside a canonical Git workspace. Agent logs persist before SSE delivery. Package boundaries isolate database, shared contracts, providers, project memory, execution policy, and context generation.

## Update — 2026-07-22T05:58:48Z
- What changed: Established two-process monorepo architecture documented in `docs/ARCHITECTURE.md`.
- Why: Separate untrusted web input from local coding execution and keep provider-specific behavior replaceable.
- Task: bootstrap-mvp
- Agent: codex
- Evidence: npm run typecheck; npm run build
- Confidence: HIGH
