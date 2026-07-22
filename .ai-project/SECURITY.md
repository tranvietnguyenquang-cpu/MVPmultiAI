# Security

Workspace roots are canonicalized; traversal is rejected. Commands are structured, allowlisted, shell-free, time-limited, cancellable, output-limited, and run with secret-bearing environment keys omitted. Logs redact common tokens, credentials, private keys, and connection strings. Destructive categories require approval records. The worker has no public endpoint.

## Update — 2026-07-22T05:58:48Z
- What changed: Implemented the MVP execution security boundary and upgraded to current Next.js 16.2.11, React 19.2.8, Prisma 6.19.3, and BullMQ 5.80.10.
- Why: Minimize local code-execution and known dependency risk.
- Task: bootstrap-mvp
- Agent: codex
- Evidence: packages/execution tests; npm audit; official Next.js security advisory
- Confidence: HIGH
