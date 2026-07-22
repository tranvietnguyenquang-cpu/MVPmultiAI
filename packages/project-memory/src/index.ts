import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const MEMORY_FILES = ["PROJECT.md","ARCHITECTURE.md","DECISIONS.md","CODING_RULES.md","CURRENT_STATE.md","CURRENT_TASK.md","KNOWN_ISSUES.md","BACKLOG.md","DATABASE.md","SECURITY.md","TEST_STATUS.md","CHANGELOG.md"] as const;

export async function initializeProjectMemory(workspace: string): Promise<string[]> {
  const root = path.join(workspace, ".ai-project");
  await mkdir(path.join(root, "checkpoints"), { recursive: true });
  const created: string[] = [];
  for (const name of MEMORY_FILES) {
    const file = path.join(root, name);
    try {
      const handle = await open(file, "wx");
      await handle.writeFile(`# ${name.replace(".md", "").replaceAll("_", " ")}\n\n`);
      await handle.close();
      created.push(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  return created;
}

export async function readMemory(workspace: string, name: typeof MEMORY_FILES[number]): Promise<string> {
  try { return await readFile(path.join(workspace, ".ai-project", name), "utf8"); } catch { return ""; }
}

export async function appendMemoryUpdate(input: { workspace: string; file: typeof MEMORY_FILES[number]; changed: string; reason: string; taskId?: string; agent: string; evidence?: string; confidence: "LOW" | "MEDIUM" | "HIGH"; timestamp?: Date }): Promise<void> {
  await initializeProjectMemory(input.workspace);
  const timestamp = (input.timestamp ?? new Date()).toISOString();
  const entry = [`\n## Update — ${timestamp}`,`- What changed: ${input.changed}`,`- Why: ${input.reason}`,`- Task: ${input.taskId ?? "none"}`,`- Agent: ${input.agent}`,`- Evidence: ${input.evidence ?? "none"}`,`- Confidence: ${input.confidence}`,""] .join("\n");
  const file = path.join(input.workspace, ".ai-project", input.file);
  const current = await readFile(file, "utf8");
  await writeFile(file, current + entry, "utf8");
}

export async function writeCheckpointFile(workspace: string, checkpointId: string, content: unknown): Promise<string> {
  const dir = path.join(workspace, ".ai-project", "checkpoints");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${checkpointId}.json`);
  await writeFile(file, JSON.stringify(content, null, 2), { encoding: "utf8", flag: "wx" });
  return file;
}
