import { readFileSync } from "node:fs";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

/**
 * Minimal .env loader (no dotenv dependency): the disposable Postgres/Redis stack's
 * connection details live in .env.test - deliberately never the repo-root .env, which
 * holds the same DATABASE_URL/REDIS_URL `npm run dev:local` uses for the real local-beta
 * stack. Merely importing @prisma/client auto-loads that root .env for any variable not
 * already set in process.env, so both this config's own process and the Next.js server it
 * spawns must have DATABASE_URL/REDIS_URL set here first, before anything gets a chance to
 * fall back to it.
 */
function loadDotEnv(file: string): void {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key]) continue;
    process.env[key] = rawValue.replace(/^["']|["']$/g, "");
  }
}
loadDotEnv(path.resolve(__dirname, ".env.test"));
// Explicit, not merely inherited: this is the fail-closed signal packages/database and
// apps/web/lib/redis.ts require before they'll allow a client to be constructed at all
// (see the shared assertDisposableDatabaseUrl/assertDisposableRedisUrl checks there).
process.env.PROJECT_RELAY_TEST_MODE = "true";

const PORT = process.env.PROJECT_RELAY_E2E_PORT ?? "3300";
// Next.js's own NextRequest.nextUrl.origin always reports "http://localhost:<port>"
// regardless of the actual Host header used to connect, so the browser must navigate via
// "localhost" (not "127.0.0.1") for the app's same-origin CSRF check to see a match - the
// server still only *binds* to the loopback interface (127.0.0.1), which "localhost"
// resolves to; this is purely which hostname the browser uses to reach it.
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  use: { baseURL: BASE_URL, trace: "retain-on-failure" },
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  webServer: {
    command: "npm run build -w @project-relay/web && npm run start -w @project-relay/web",
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      PORT,
      PROJECT_RELAY_BIND_HOST: "127.0.0.1",
      DATABASE_URL: process.env.DATABASE_URL ?? "",
      REDIS_URL: process.env.REDIS_URL ?? "",
      PROJECT_RELAY_TEST_MODE: "true",
      PROJECT_RELAY_QUEUE_PREFIX: process.env.PROJECT_RELAY_QUEUE_PREFIX ?? "projectrelay-test"
    }
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }]
});
