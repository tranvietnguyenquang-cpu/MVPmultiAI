import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

type PackageManifest = {
  name: string;
  dependencies?: Record<string, string>;
};

async function sourceFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async entry => {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    if (!/\.(ts|tsx)$/.test(entry.name) || /\.(test|spec)\./.test(entry.name) || entry.name === "testing.ts") return [];
    return [full];
  }));
  return nested.flat();
}

async function workspacePackages(): Promise<Map<string, { directory: string; manifest: PackageManifest }>> {
  const packages = new Map<string, { directory: string; manifest: PackageManifest }>();
  for (const parent of ["packages", "apps"]) {
    const parentPath = path.join(process.cwd(), parent);
    for (const entry of await readdir(parentPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = path.join(parentPath, entry.name);
      try {
        const manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8")) as PackageManifest;
        packages.set(manifest.name, { directory, manifest });
      } catch {}
    }
  }
  return packages;
}

function workspaceImports(contents: string): string[] {
  return [...contents.matchAll(/(?:from\s+|import\s*\()\s*["'](@project-relay\/[^"']+)["']/g)].map(match => match[1] as string);
}

const forbiddenRuntimePatterns = [
  /from\s+["']bullmq["']/,
  /from\s+["']ioredis["']/,
  /@project-relay\/execution/,
  /@project-relay\/providers/,
  /apps\/worker|apps\\worker/,
  /getSessionQueue|agent-sessions|conversation-message/,
  /(?:from\s+|import\s*\()\s*["']cross-spawn["']/,
  // Real Claude CLI integration (Milestone 2.3B) is a subprocess adapter, never an
  // Anthropic API/SDK integration. This pattern stays forbidden even though "claude"
  // itself is now a legitimate import (see the narrowed check further down this file).
  /(?:from\s+|import\s*\()\s*["'](?:openai|@anthropic-ai\/[^"']+|@google\/generative-ai|@google\/genai|@modelcontextprotocol\/[^"']+)["']/,
  /\bshell\s*:\s*true\b/,
  /\bMcpServer\s*\(/,
  /api\.(?:openai|anthropic)\.com|generativelanguage\.googleapis\.com|api\.deepseek\.com/i,
  /\b(?:git|docker)\s+(?:commit|checkout|reset|push|pull|add|rm|build|run)\b/i,
  /\/api\/sessions/,
  /local-auth|csrf-client/
];

function forbiddenRuntimeReferences(contents: string): RegExp[] {
  return forbiddenRuntimePatterns.filter(pattern => pattern.test(contents));
}

const v2SourceRoots = [
  path.join(process.cwd(), "packages", "relay-v2-domain", "src"),
  path.join(process.cwd(), "packages", "relay-v2-persistence", "src"),
  path.join(process.cwd(), "packages", "relay-v2-orchestrator", "src"),
  path.join(process.cwd(), "packages", "relay-v2-execution", "src"),
  path.join(process.cwd(), "packages", "relay-v2-reviewer", "src"),
  path.join(process.cwd(), "packages", "relay-v2-claude-reviewer", "src"),
  path.join(process.cwd(), "apps", "web", "app", "api", "v2"),
  path.join(process.cwd(), "apps", "web", "app", "v2"),
  path.join(process.cwd(), "apps", "web", "components", "relay-v2"),
  path.join(process.cwd(), "apps", "web", "lib", "relay-v2")
];

describe("Relay v2 Milestone 2.2 execution isolation", () => {
  it("walks the transitive workspace dependency graph and cannot reach execution infrastructure", async () => {
    const files = (await Promise.all(v2SourceRoots.map(sourceFiles))).flat();
    files.push(path.join(process.cwd(), "apps", "web", "lib", "api-errors.ts"), path.join(process.cwd(), "apps", "web", "lib", "csrf.ts"));
    const packages = await workspacePackages();
    const pending = new Set<string>();
    for (const file of files) {
      for (const imported of workspaceImports(await readFile(file, "utf8"))) pending.add(imported);
    }
    const reachable = new Set<string>();
    while (pending.size) {
      const name = pending.values().next().value as string;
      pending.delete(name);
      if (reachable.has(name)) continue;
      reachable.add(name);
      const item = packages.get(name);
      if (!item) continue;
      for (const dependency of Object.keys(item.manifest.dependencies ?? {})) {
        if (packages.has(dependency)) pending.add(dependency);
      }
    }
    expect(reachable).toContain("@project-relay/local-safety");
    expect(reachable).toContain("@project-relay/relay-v2-execution");
    expect([...reachable]).not.toEqual(expect.arrayContaining(["@project-relay/execution", "@project-relay/providers", "@project-relay/worker"]));
    for (const name of reachable) {
      const dependencies = packages.get(name)?.manifest.dependencies ?? {};
      expect(Object.keys(dependencies), `${name} has an execution dependency`).not.toEqual(expect.arrayContaining(["bullmq", "ioredis", "@project-relay/execution", "@project-relay/providers"]));
    }
    expect(packages.get("@project-relay/local-safety")?.manifest.dependencies).toBeUndefined();
  });

  it("contains no direct production import or call path to queues, providers, or workers", async () => {
    const roots = [
      ...v2SourceRoots,
      path.join(process.cwd(), "packages", "local-safety", "src"),
    ];
    const files = (await Promise.all(roots.map(sourceFiles))).flat();
    for (const file of files) {
      const contents = await readFile(file, "utf8");
      expect(forbiddenRuntimeReferences(contents), `${path.relative(process.cwd(), file)} contains a forbidden runtime reference`).toEqual([]);
      // Milestone 2.3B implements a real Claude CLI reviewer, so "claude" is now a
      // legitimate substring in an import specifier (the new
      // @project-relay/relay-v2-claude-reviewer package, and this package's own
      // relative imports like "./claude-capabilities.js"). Gemini, DeepSeek, and MCP
      // remain fully unimplemented and stay forbidden. The Anthropic API/SDK itself
      // is still separately forbidden above regardless of this exemption.
      expect(contents, `${path.relative(process.cwd(), file)} imports an unimplemented provider runtime`).not.toMatch(/(?:from\s+|import\s*\()\s*["'][^"']*(?:gemini|deepseek|mcp)[^"']*["']/i);
    }
  });

  it("allows child_process only inside the SafeProcessRunner boundary", async () => {
    const files = (await Promise.all(v2SourceRoots.map(sourceFiles))).flat();
    const processBoundary = path.join(process.cwd(), "packages", "relay-v2-execution", "src", "process-runner.ts");
    const importPattern = /(?:from\s+|import\s*\()\s*["']node:child_process["']/;
    const callers: string[] = [];
    for (const file of files) if (importPattern.test(await readFile(file, "utf8"))) callers.push(file);
    expect(callers).toEqual([processBoundary]);
    const boundary = await readFile(processBoundary, "utf8");
    expect(boundary).toContain("shell: false");
    expect(boundary).not.toContain("shell: true");
    for (const root of [
      path.join(process.cwd(), "apps", "web", "app", "api", "v2"),
      path.join(process.cwd(), "apps", "web", "app", "v2"),
      path.join(process.cwd(), "apps", "web", "components", "relay-v2")
    ]) {
      for (const file of await sourceFiles(root)) {
        const contents = await readFile(file, "utf8");
        expect(contents).not.toMatch(/node:child_process|process-runner|\bspawn\s*\(/);
      }
    }
  });

  it("detects forbidden runtime imports in UI roots without rejecting executor display labels", () => {
    expect(v2SourceRoots).toEqual(expect.arrayContaining([
      path.join(process.cwd(), "apps", "web", "app", "v2"),
      path.join(process.cwd(), "apps", "web", "components", "relay-v2")
    ]));
    const forbiddenUiFixture = `import { providerRegistry } from "@project-relay/providers";\nvoid providerRegistry;`;
    expect(forbiddenRuntimeReferences(forbiddenUiFixture)).not.toEqual([]);
    expect(forbiddenRuntimeReferences(`const labels = ["CODEX", "CLAUDE", "GEMINI", "DEEPSEEK"];`)).toEqual([]);
  });

  it("keeps approve/cancel route responses explicit about not queueing execution", async () => {
    for (const relative of ["approve/route.ts", "cancel/route.ts"]) {
      const file = path.join(process.cwd(), "apps", "web", "app", "api", "v2", "tasks", "[id]", relative);
      expect(await readFile(file, "utf8")).toContain("executionQueued: false");
    }
  });

  it("uses the v2-only CSRF client without bootstrapping a PostgreSQL-backed legacy session", async () => {
    const client = await readFile(path.join(process.cwd(), "apps", "web", "lib", "relay-v2", "client.ts"), "utf8");
    expect(client).toContain("/api/csrf");
    expect(client).not.toContain("/api/auth/local-session");
  });
});

describe("Relay v2 Milestone 2.3A reviewer isolation", () => {
  it("keeps the reviewer package's own dependency edges limited to domain, persistence, local-safety, and zod", async () => {
    const manifest = JSON.parse(await readFile(path.join(process.cwd(), "packages", "relay-v2-reviewer", "package.json"), "utf8")) as PackageManifest;
    const dependencyNames = Object.keys(manifest.dependencies ?? {});
    expect(dependencyNames.sort()).toEqual([
      "@project-relay/local-safety", "@project-relay/relay-v2-domain", "@project-relay/relay-v2-persistence", "zod"
    ].sort());
    expect(dependencyNames).not.toEqual(expect.arrayContaining([
      "@project-relay/relay-v2-execution", "@project-relay/execution", "@project-relay/providers",
      "bullmq", "ioredis", "cross-spawn"
    ]));
  });

  it("never lets FakeReviewer or the review engine import SafeProcessRunner or spawn a process", async () => {
    const files = await sourceFiles(path.join(process.cwd(), "packages", "relay-v2-reviewer", "src"));
    for (const file of files) {
      const contents = await readFile(file, "utf8");
      expect(contents, `${path.relative(process.cwd(), file)} references the process-running boundary`).not.toMatch(/process-runner|node:child_process|cross-spawn|SafeProcessRunner/);
    }
  });

  it("never gives FakeReviewer filesystem, network, or Git access", async () => {
    const fakeReviewer = await readFile(path.join(process.cwd(), "packages", "relay-v2-reviewer", "src", "fake-reviewer.ts"), "utf8");
    expect(fakeReviewer).not.toMatch(/node:fs|node:net|node:http|node:https|node:child_process/);
  });

  it("registers exactly fake-reviewer and claude-cli in this milestone's review services wiring", async () => {
    const server = await readFile(path.join(process.cwd(), "apps", "web", "lib", "relay-v2", "server.ts"), "utf8");
    expect(server).toContain("new FakeReviewer()");
    expect(server).toMatch(/ClaudeCliReviewer/);
    expect(server).not.toMatch(/codex-reviewer|CodexReviewer|gemini-reviewer|GeminiReviewer|deepseek-reviewer|DeepseekReviewer/i);
  });

  it("keeps the claude-cli reviewer package's dependency edges to exactly domain, execution, persistence, reviewer, local-safety, and zod", async () => {
    const manifest = JSON.parse(await readFile(path.join(process.cwd(), "packages", "relay-v2-claude-reviewer", "package.json"), "utf8")) as PackageManifest;
    const dependencyNames = Object.keys(manifest.dependencies ?? {});
    expect(dependencyNames.sort()).toEqual([
      "@project-relay/local-safety", "@project-relay/relay-v2-domain", "@project-relay/relay-v2-execution",
      "@project-relay/relay-v2-persistence", "@project-relay/relay-v2-reviewer", "zod"
    ].sort());
    expect(dependencyNames).not.toEqual(expect.arrayContaining(["@project-relay/execution", "@project-relay/providers", "bullmq", "ioredis", "cross-spawn"]));
  });

  it("never exposes commit, push, merge, retry, or deployment controls from the review UI", async () => {
    const files = [
      ...(await sourceFiles(path.join(process.cwd(), "apps", "web", "components", "relay-v2"))).filter(file => /review/i.test(file)),
      path.join(process.cwd(), "apps", "web", "app", "v2", "reviews", "[id]", "page.tsx")
    ];
    for (const file of files) {
      const contents = await readFile(file, "utf8");
      expect(contents, `${path.relative(process.cwd(), file)} exposes a commit/push/merge/deploy control`).not.toMatch(/>Commit|>Push|>Merge|>Deploy|git\s+(commit|push|merge)/i);
    }
  });
});
