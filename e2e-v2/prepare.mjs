/* global process */
import { execFileSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

const dataDir = path.resolve(process.env.RELAY_V2_DATA_DIR ?? path.join(process.cwd(), ".relay-data", "playwright-v2"));
const allowedRoot = path.resolve(process.cwd(), ".relay-data");
if (!dataDir.startsWith(`${allowedRoot}${path.sep}`)) throw new Error("Refusing to initialize Relay v2 E2E data outside .relay-data.");
await rm(dataDir, { recursive: true, force: true });
await mkdir(path.join(dataDir, "workspace", ".git"), { recursive: true });
process.env.RELAY_V2_DATABASE_URL = `file:${path.join(dataDir, "relay-v2.db").replace(/\\/g, "/")}`;
execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy", "--schema", "packages/relay-v2-persistence/prisma/schema.prisma"], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit"
});
