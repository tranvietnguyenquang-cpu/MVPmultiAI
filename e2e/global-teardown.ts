import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_MANIFEST = path.join(__dirname, ".e2e-workspace.json");

export default async function globalTeardown(): Promise<void> {
  // Use the production cleanup predicate so failed specs from an interrupted run are
  // removed on the next teardown without ever touching a real project.
  const { commitVerificationCleanup, prisma } = await import("@project-relay/database");
  await commitVerificationCleanup();
  await prisma.$disconnect();
  if (existsSync(WORKSPACE_MANIFEST)) {
    const { workspace } = JSON.parse(readFileSync(WORKSPACE_MANIFEST, "utf8")) as { workspace: string };
    rmSync(workspace, { recursive: true, force: true });
    rmSync(WORKSPACE_MANIFEST, { force: true });
  }
  // Deliberately do not stop the disposable Postgres/Redis compose stack here: other
  // concurrently running test/dev workflows may depend on the same containers staying up.
}
