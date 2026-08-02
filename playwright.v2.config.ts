import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const port = process.env.PROJECT_RELAY_V2_E2E_PORT ?? "3400";
const baseURL = `http://localhost:${port}`;
const dataDir = path.resolve(process.cwd(), ".relay-data", "playwright-v2");
process.env.RELAY_V2_E2E_DATA_DIR = dataDir;

export default defineConfig({
  testDir: "./e2e-v2",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  use: { baseURL, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }]
});
