# ProjectRelay

Local-first, evidence-based context continuity for AI coding sessions.

## Run locally

1. Copy `.env.example` to `.env`.
2. Start dependencies: `docker compose up -d`.
3. Install and generate: `npm install && npm run db:generate`.
4. Apply the migration: `npm run db:migrate`.
5. Start web and worker: `npm run dev`.
6. Open `http://localhost:3000`.

Codex execution requires the locally installed CLI. Verify with `codex --version` and authenticate using `codex login`. ProjectRelay does not collect provider passwords or credentials.

See `docs/PRODUCT_SPEC.md`, `docs/ARCHITECTURE.md`, and `docs/IMPLEMENTATION_PLAN.md` for product and system details.
