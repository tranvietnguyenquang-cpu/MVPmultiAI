import { defineConfig } from "vitest/config";

/**
 * Relay v2 uses disposable SQLite databases and must not start or touch the legacy
 * PostgreSQL/Redis validation stack. This dedicated config is the isolation boundary.
 */
export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: {
    include: [
      "packages/relay-v2-*/src/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "packages/local-safety/src/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "apps/web/**/*relay-v2*.{test,spec}.?(c|m)[jt]s?(x)",
      "apps/web/app/api/v2/**/*.{test,spec}.?(c|m)[jt]s?(x)"
    ],
    fileParallelism: false,
    env: {
      PROJECT_RELAY_TEST_MODE: "true"
    }
  }
});
