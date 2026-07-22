# ProjectRelay

Local-first, evidence-based context continuity for AI coding sessions.

## Run locally

1. Copy `.env.example` to `.env`.
2. Start dependencies: `docker compose up -d`.
3. Install and generate: `npm install && npm run db:generate`.
4. Apply the migration: `npm run db:migrate`.
5. Start web and worker: `npm run dev`.
6. Open `http://localhost:3000`.

Provider execution uses only locally installed CLI authentication. Verify Codex with `codex --version` and `codex login status`; verify Claude Code with `claude --version` and `claude auth status`. ProjectRelay never collects, copies, or stores provider passwords, tokens, cookies, credential paths, or environment values.

Optional real checks are excluded from normal CI:

```sh
npm run smoke:codex
npm run smoke:claude
```

Project registration selects server-owned command IDs; browser input cannot define executables or arguments. Claude review and verification sessions are read-only and require an explicit user action. Providers never call one another autonomously.

See `docs/PRODUCT_SPEC.md`, `docs/ARCHITECTURE.md`, and `docs/IMPLEMENTATION_PLAN.md` for product and system details.
