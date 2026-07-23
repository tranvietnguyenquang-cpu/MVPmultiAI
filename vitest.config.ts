import { defaultExclude, defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: {
    // Integration tests share one real, non-isolated Postgres instance (no per-file
    // transactions), including global singleton rows like ProviderHealth. Running test
    // files sequentially avoids cross-file races on that shared state.
    fileParallelism: false,
    // e2e/*.spec.ts are Playwright browser tests (run via `npm run test:browser`), not
    // Vitest tests - their global test()/expect() would otherwise collide with Playwright's.
    exclude: [...defaultExclude, "e2e/**"]
  }
});
