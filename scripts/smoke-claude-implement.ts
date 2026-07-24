import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import crossSpawn from "cross-spawn";
import { providerRegistry } from "@project-relay/providers";
import type { TaskCapsuleContent } from "@project-relay/shared";

/**
 * Real-CLI-gated integration proof for Claude's newly-supported workspace-write
 * capability (see claude-cli-provider.ts). Runs the actual installed, authenticated
 * Claude Code CLI against two disposable throwaway git repositories - never the real
 * project - and proves:
 *
 *   1. A Claude IMPLEMENT (capability WORKSPACE_WRITE) session can create a file
 *      inside its registered workspace.
 *   2. A Claude REVIEW (capability READ_ONLY) session, given the identical
 *      instruction and target filename, cannot: the file is never created.
 *
 * Never part of test:all/CI, matching the smoke:session:* convention - invoke
 * explicitly via `npm run smoke:claude:implement`. Consumes real API usage.
 */
function run(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = crossSpawn(command, args, { stdio: "ignore", cwd, shell: false });
    child.once("error", reject);
    child.once("close", code => (code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} exited with code ${String(code)}`))));
  });
}

async function disposableGitWorkspace(prefix: string): Promise<string> {
  const workspace = mkdtempSync(path.join(tmpdir(), prefix));
  await run("git", ["init"], workspace);
  await run("git", ["config", "user.email", "smoke@project-relay.local"], workspace);
  await run("git", ["config", "user.name", "ProjectRelay Smoke"], workspace);
  return workspace;
}

const TARGET_FILE = "smoke-target.txt";
const TARGET_CONTENT = "SMOKE_OK";

function capsule(mode: "IMPLEMENT" | "REVIEW"): TaskCapsuleContent {
  return {
    task: {
      id: `smoke-claude-${mode.toLowerCase()}`,
      title: "Claude workspace-write smoke check",
      objective: `Create a file named exactly "${TARGET_FILE}" in the root of this repository containing exactly the text "${TARGET_CONTENT}" and nothing else, then stop.`,
      userRequest: `Create a file named exactly "${TARGET_FILE}" in the root of this repository containing exactly the text "${TARGET_CONTENT}" and nothing else. Do not create or modify any other file. If you are unable to create files, say so briefly instead.`,
    },
    architectureDecisions: [],
    codingRules: "",
    sourceContext: [],
    knownIssues: "",
    acceptanceCriteria: [],
    latestTestEvidence: [],
    prohibitedChanges: [],
    conversationMode: mode,
  };
}

async function runSession(workspace: string, mode: "IMPLEMENT" | "REVIEW"): Promise<void> {
  const provider = providerRegistry.get("claude-cli");
  const session = await provider.createSession({
    workspace,
    taskId: `smoke-claude-${mode.toLowerCase()}`,
    capability: mode === "IMPLEMENT" ? "WORKSPACE_WRITE" : "READ_ONLY",
    role: mode === "IMPLEMENT" ? "IMPLEMENTER" : "REVIEWER",
  });
  const consume = (async () => {
    for await (const _item of provider.streamEvents(session.id)) {
      // Draining is required for the session to reach completion; content isn't needed here.
    }
  })();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  try {
    await provider.startSession(session, capsule(mode), controller.signal);
    await consume;
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const provider = providerRegistry.get("claude-cli");
  const installation = await provider.refreshHealth();
  if (!installation.installed) {
    console.error(provider.setupInstructions);
    process.exitCode = 2;
    return;
  }
  const auth = await provider.probeAuthentication();
  if (!auth.available) {
    console.error(`claude-cli is ${auth.authentication.toLowerCase()}. ${provider.setupInstructions}`);
    process.exitCode = 2;
    return;
  }

  let ok = true;
  const implementWorkspace = await disposableGitWorkspace("project-relay-smoke-implement-");
  const reviewWorkspace = await disposableGitWorkspace("project-relay-smoke-review-");
  try {
    await runSession(implementWorkspace, "IMPLEMENT");
    const implementPath = path.join(implementWorkspace, TARGET_FILE);
    const implementCreated = existsSync(implementPath);
    const implementContent = implementCreated ? readFileSync(implementPath, "utf8").trim() : null;
    console.log(JSON.stringify({ step: "IMPLEMENT", workspace: implementWorkspace, fileCreated: implementCreated, content: implementContent }));
    if (!implementCreated || implementContent !== TARGET_CONTENT) {
      console.error("FAIL: Claude IMPLEMENT did not create the expected file with the expected content.");
      ok = false;
    }

    await runSession(reviewWorkspace, "REVIEW");
    const reviewPath = path.join(reviewWorkspace, TARGET_FILE);
    const reviewCreated = existsSync(reviewPath);
    console.log(JSON.stringify({ step: "REVIEW", workspace: reviewWorkspace, fileCreated: reviewCreated }));
    if (reviewCreated) {
      console.error("FAIL: Claude REVIEW created a file despite read-only capability.");
      ok = false;
    }
  } finally {
    rmSync(implementWorkspace, { recursive: true, force: true });
    rmSync(reviewWorkspace, { recursive: true, force: true });
  }

  if (!ok) {
    process.exitCode = 1;
    return;
  }
  console.log("PASS: Claude IMPLEMENT created the file; Claude REVIEW could not.");
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
