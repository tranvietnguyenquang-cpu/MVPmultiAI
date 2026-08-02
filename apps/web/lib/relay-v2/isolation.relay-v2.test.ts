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
  /(?:from\s+|import\s*\()\s*["'](?:node:child_process|cross-spawn)["']/,
  /(?:from\s+|import\s*\()\s*["'](?:openai|@anthropic-ai\/[^"']+|@google\/generative-ai|@google\/genai|@modelcontextprotocol\/[^"']+)["']/,
  /\b(?:exec|execFile|execSync|execFileSync|spawn|spawnSync)\s*\(/,
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
  path.join(process.cwd(), "apps", "web", "app", "api", "v2"),
  path.join(process.cwd(), "apps", "web", "app", "v2"),
  path.join(process.cwd(), "apps", "web", "components", "relay-v2"),
  path.join(process.cwd(), "apps", "web", "lib", "relay-v2")
];

describe("Relay v2 Milestone 2.1 execution isolation", () => {
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

  it("contains no direct production import or call path to queues, providers, workers, or child processes", async () => {
    const roots = [
      ...v2SourceRoots,
      path.join(process.cwd(), "packages", "local-safety", "src"),
    ];
    const files = (await Promise.all(roots.map(sourceFiles))).flat();
    for (const file of files) {
      const contents = await readFile(file, "utf8");
      expect(forbiddenRuntimeReferences(contents), `${path.relative(process.cwd(), file)} contains a forbidden runtime reference`).toEqual([]);
      if (file.includes(`${path.sep}relay-v2-execution${path.sep}`) || file.includes(`${path.sep}api${path.sep}v2${path.sep}executions${path.sep}`)) {
        expect(contents, `${path.relative(process.cwd(), file)} names a real provider integration`).not.toMatch(/\b(?:codex|claude|gemini|deepseek|mcp)\b/i);
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
