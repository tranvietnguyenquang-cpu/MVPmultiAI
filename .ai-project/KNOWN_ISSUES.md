# Known Issues

1. `prisma migrate deploy` reaches the configured datasource but the Windows schema engine exits with an opaque error. Diagnostic output initially showed invalid credentials; after resetting the disposable role password it still failed before issuing SQL. The checked-in SQL migration was applied successfully inside PostgreSQL and created 12 tables.
2. `codex --version` returns Access denied inside this managed sandbox. Verify from a normal terminal before running a session.
3. The Compose Redis service cannot bind host port 6379 because an authenticated Redis already owns it. Supply its password in `REDIS_URL`, stop it and use the Compose Redis, or change the Compose host port.
4. `npm audit --omit=dev` reports vulnerabilities in PostCSS and Sharp versions bundled by the current latest Next.js 16.2.11. The app does not configure remote images or use `next/image`, reducing Sharp exposure, but update Next as soon as a patched release ships.

## Update — 2026-07-22T05:58:48Z
- What changed: Captured concrete environment and dependency blockers.
- Why: Prevent a future agent from assuming unverified infrastructure success.
- Task: bootstrap-mvp
- Agent: codex
- Evidence: Prisma debug output; Docker logs; npm audit --omit=dev; official Next.js support/security guidance
- Confidence: HIGH
