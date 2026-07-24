// Harmless standalone fixture used only by scripts/start-local.test.mjs, standing in
// for the real `dev:web` / `dev:worker` workspace scripts so launcher orchestration can
// be tested without booting Next.js or connecting to real PostgreSQL/Redis.
import { createServer } from "node:http";

const role = process.argv[2];
console.log(`[fixture-${role}] pid=${process.pid}`);

const shouldFail = process.env[`FIXTURE_${String(role).toUpperCase()}_FAIL`] === "1";

if (shouldFail) {
  // A short delay so the launcher's identity-capture (a few sequential PowerShell
  // calls on Windows) reliably completes before this process exits, exercising the
  // "process failed during startup" path rather than racing the "identity capture
  // failed" path a truly instant crash could hit instead.
  setTimeout(() => {
    console.error(`[fixture-${role}] simulated startup failure`);
    process.exit(role === "worker" ? 7 : 1);
  }, 1200);
} else if (role === "web") {
  const port = Number(process.env.PROJECT_RELAY_WEB_PORT || 3000);
  const delayMs = Number(process.env.FIXTURE_DELAY_MS || 0);
  setTimeout(() => {
    const server = createServer((_req, res) => { res.writeHead(200); res.end("ok"); });
    server.listen(port, "127.0.0.1", () => console.log(`[fixture-web] listening on ${port}`));
  }, delayMs);
} else if (role === "worker") {
  setInterval(() => {}, 60_000);
} else {
  console.error(`Unknown fixture role: ${role}`);
  process.exit(2);
}
