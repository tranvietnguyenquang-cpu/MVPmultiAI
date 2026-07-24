// Harmless fixture that simulates the exact defect this launcher fix targets: an
// intermediate wrapper (standing in for the cmd.exe/npm-cli.js chain `npm run dev:web`
// produces on Windows) that spawns the real long-lived process and then exits on its
// own, before the real process does. Used only by scripts/start-local-windows-tree.test.mjs.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const role = process.argv[2];
const here = path.dirname(fileURLToPath(import.meta.url));
const grandchildPath = path.join(here, "launcher-fixture.mjs");
const childCount = Number(process.env.FIXTURE_WRAPPER_CHILDREN || 1);
const exitDelayMs = Number(process.env.FIXTURE_WRAPPER_EXIT_DELAY_MS || 500);

// detached: true mirrors what the real npm/cmd chain does in production: the real
// next/tsx process is not tied to any one intermediate wrapper's process lifetime, which
// is exactly why it can survive an intermediate wrapper exiting (Windows would otherwise
// tear down a plain, non-detached child through the spawning process's own job object as
// soon as that immediate parent is reaped).
const detached = process.env.FIXTURE_WRAPPER_DETACHED === "1";
const children = [];
for (let i = 0; i < childCount; i += 1) {
  const grandchild = spawn(process.execPath, [grandchildPath, role], { stdio: "ignore", windowsHide: true, detached });
  if (detached) grandchild.unref();
  children.push(grandchild);
}
console.log(`[wrapper-${role}] pid=${process.pid} spawned ${children.map((c) => c.pid).join(",")}`);

setTimeout(() => {
  console.log(`[wrapper-${role}] exiting while descendant(s) keep running`);
  process.exit(0);
}, exitDelayMs);
