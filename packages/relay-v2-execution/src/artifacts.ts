import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { redactSecrets } from "@project-relay/local-safety";

export type ArtifactMetadata = {
  artifactType: "LOG" | "CHANGED_FILES" | "CAPSULE" | "BASELINE_GIT" | "FINAL_GIT" | "PATCH" | "VERIFICATION";
  relativePath: string;
  sha256: string;
  byteCount: number;
  truncated: boolean;
};

export class ExecutionArtifactStore {
  constructor(readonly artifactsRoot: string, readonly maxLogBytes = 5 * 1024 * 1024) {}

  private sessionDirectory(sessionId: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(sessionId)) throw new Error("Invalid execution session ID for artifact storage.");
    return path.join(this.artifactsRoot, "executions", sessionId);
  }

  private relative(absolutePath: string): string {
    return path.relative(this.artifactsRoot, absolutePath).replace(/\\/g, "/");
  }

  artifactDirectory(sessionId: string): string {
    return this.relative(this.sessionDirectory(sessionId));
  }

  async initializeLog(sessionId: string): Promise<void> {
    const directory = this.sessionDirectory(sessionId);
    await mkdir(directory, { recursive: true });
    const handle = await open(path.join(directory, "output.ndjson"), "wx").catch(error => {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
      throw error;
    });
    await handle?.close();
  }

  async appendLog(sessionId: string, value: unknown): Promise<boolean> {
    await this.initializeLog(sessionId);
    const file = path.join(this.sessionDirectory(sessionId), "output.ndjson");
    const current = (await stat(file)).size;
    const line = Buffer.from(`${redactSecrets(JSON.stringify(value))}\n`, "utf8");
    const remaining = Math.max(0, this.maxLogBytes - current);
    if (remaining > 0) await appendFile(file, line.subarray(0, remaining));
    return line.length > remaining;
  }

  async finalizeLog(sessionId: string, truncated = false): Promise<ArtifactMetadata> {
    await this.initializeLog(sessionId);
    const file = path.join(this.sessionDirectory(sessionId), "output.ndjson");
    const contents = await readFile(file);
    return {
      artifactType: "LOG",
      relativePath: this.relative(file),
      sha256: createHash("sha256").update(contents).digest("hex"),
      byteCount: contents.byteLength,
      truncated
    };
  }

  async writeChangedFiles(sessionId: string, changedFiles: readonly string[]): Promise<ArtifactMetadata> {
    const directory = this.sessionDirectory(sessionId);
    await mkdir(directory, { recursive: true });
    const target = path.join(directory, "changed-files.json");
    const temporary = path.join(directory, `.changed-files-${randomUUID()}.tmp`);
    const contents = Buffer.from(`${redactSecrets(JSON.stringify({ changedFiles }, null, 2))}\n`, "utf8");
    await writeFile(temporary, contents, { flag: "wx" });
    await rename(temporary, target);
    return {
      artifactType: "CHANGED_FILES",
      relativePath: this.relative(target),
      sha256: createHash("sha256").update(contents).digest("hex"),
      byteCount: contents.byteLength,
      truncated: false
    };
  }


  async writeArtifact(
    sessionId: string,
    artifactType: Exclude<ArtifactMetadata["artifactType"], "LOG" | "CHANGED_FILES">,
    filename: string,
    value: unknown,
    maxBytes = this.maxLogBytes
  ): Promise<ArtifactMetadata> {
    if (!/^[a-z0-9][a-z0-9.-]{0,100}$/i.test(filename)) throw new Error("Invalid execution artifact filename.");
    const directory = this.sessionDirectory(sessionId);
    await mkdir(directory, { recursive: true });
    const target = path.join(directory, filename);
    const temporary = path.join(directory, `.${filename}-${randomUUID()}.tmp`);
    const serialized = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    const full = Buffer.from(`${redactSecrets(serialized)}\n`, "utf8");
    const contents = full.subarray(0, maxBytes);
    await writeFile(temporary, contents, { flag: "wx" });
    await rename(temporary, target);
    return {
      artifactType,
      relativePath: this.relative(target),
      sha256: createHash("sha256").update(contents).digest("hex"),
      byteCount: contents.byteLength,
      truncated: full.byteLength > contents.byteLength
    };
  }
}
