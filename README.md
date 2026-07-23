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

The worker is intentionally not a Docker service: run it natively on Windows as the same signed-in user who authenticated the local Codex and Claude CLIs. Provider health is metadata only; unsupported quota values render as “Exact quota unavailable.”

## Security boundary (temporary, local-only)

ProjectRelay does not yet have a real multi-user authentication model. Until one exists, access control is enforced by a **temporary local-only boundary**:

- the web app only binds to a loopback host (`127.0.0.1` by default; overriding `PROJECT_RELAY_BIND_HOST` to a non-loopback address makes startup refuse to run);
- the worker refuses to start unless `DATABASE_URL` and `REDIS_URL` both resolve to loopback hosts;
- `proxy.ts` rejects any `/api/*` request that shows signs of arriving through a proxy (a non-loopback `Host`, or any `x-forwarded-for`/`x-forwarded-host` header) before same-origin CSRF validation even runs;
- a CSRF token (`GET /api/csrf`) proves same-origin intent but never grants operational access by itself;
- operational routes (creating conversations, sending messages) additionally require a server-issued local session cookie from `POST /api/auth/local-session`, which itself only succeeds over a loopback connection.

This is appropriate for a single-operator local MVP, not a substitute for real authentication in a shared or networked deployment.

See `docs/PRODUCT_SPEC.md`, `docs/ARCHITECTURE.md`, and `docs/IMPLEMENTATION_PLAN.md` for product and system details.
