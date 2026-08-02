import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createRelayV2Client } from "./client.js";
import { toPrismaSqliteUrl } from "./paths.js";

const execFileAsync = promisify(execFile);

export async function createDisposableRelayV2Database() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "relay-v2-test-"));
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const schema = path.join(repositoryRoot, "packages", "relay-v2-persistence", "prisma", "schema.prisma");
  const prismaCli = path.join(repositoryRoot, "node_modules", "prisma", "build", "index.js");
  const databasePath = path.join(dataDir, "relay-v2.db");
  await execFileAsync(process.execPath, [prismaCli, "migrate", "deploy", "--schema", schema], {
    cwd: repositoryRoot,
    windowsHide: true,
    env: { ...process.env, RELAY_V2_DATABASE_URL: toPrismaSqliteUrl(databasePath), RELAY_V2_DATA_DIR: dataDir, PROJECT_RELAY_TEST_MODE: "true" }
  });
  const result = await createRelayV2Client({ dataDir, testMode: true });
  return {
    ...result,
    async cleanup() {
      await result.client.$disconnect();
      const resolved = path.resolve(dataDir);
      if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith("relay-v2-test-")) {
        throw new Error("Refusing to remove a non-disposable Relay v2 test directory.");
      }
      await rm(resolved, { recursive: true, force: true });
    }
  };
}
