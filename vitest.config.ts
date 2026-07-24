import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultExclude, defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Minimal .env loader (no dotenv dependency, matching playwright.config.ts): loads the
 * disposable test database/Redis connection details from .env.test - never the repo-root
 * .env, which holds the same DATABASE_URL/REDIS_URL `npm run dev:local` uses for the real
 * local-beta stack. Merely importing @prisma/client auto-loads that root .env for any
 * variable not already set in process.env, so tests must have DATABASE_URL/REDIS_URL set
 * here, before any test file (or Prisma) ever gets a chance to fall back to it.
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

const testEnv = {
  DATABASE_URL: process.env.DATABASE_URL ?? "",
  REDIS_URL: process.env.REDIS_URL ?? "",
  PROJECT_RELAY_TEST_MODE: "true",
  PROJECT_RELAY_QUEUE_PREFIX: process.env.PROJECT_RELAY_QUEUE_PREFIX ?? "projectrelay-test"
};

export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: {
    env: testEnv,
    globalSetup: ["./scripts/test-infra/vitest-global-setup.ts"],
    // Integration tests share one real, non-isolated Postgres instance (no per-file
    // transactions), including global singleton rows like ProviderHealth. Running test
    // files sequentially avoids cross-file races on that shared state.
    fileParallelism: false,
    // e2e/*.spec.ts are Playwright browser tests (run via `npm run test:browser`), not
    // Vitest tests - their global test()/expect() would otherwise collide with Playwright's.
    exclude: [...defaultExclude, "e2e/**"]
  }
});
