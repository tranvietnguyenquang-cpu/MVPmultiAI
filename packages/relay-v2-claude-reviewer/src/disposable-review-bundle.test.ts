import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { prepareDisposableReviewBundle } from "./disposable-review-bundle.js";

async function exists(target: string): Promise<boolean> {
  try { await access(target); return true; } catch { return false; }
}

describe("prepareDisposableReviewBundle", () => {
  it("writes exactly the expected files and reports them unchanged before anything runs", async () => {
    const bundle = await prepareDisposableReviewBundle({
      reviewRequestId: "r1", requestHash: "a".repeat(64), materialJson: "{}", verdictJsonSchema: { type: "object" }, promptText: "prompt text"
    });
    try {
      for (const name of ["review-input.json", "review-material.json", "verdict-schema.json", "README-review-policy.txt", "prompt.txt"]) {
        expect(await exists(path.join(bundle.bundlePath, name))).toBe(true);
      }
      expect(await bundle.verifyUnchanged()).toBe(true);
    } finally {
      await bundle.cleanup();
    }
  });

  it("is created outside the current repository working directory", async () => {
    const bundle = await prepareDisposableReviewBundle({
      reviewRequestId: "r1", requestHash: "a".repeat(64), materialJson: "{}", verdictJsonSchema: {}, promptText: "prompt"
    });
    try {
      const relative = path.relative(process.cwd(), bundle.bundlePath);
      expect(relative.startsWith("..") || path.isAbsolute(relative)).toBe(true);
    } finally {
      await bundle.cleanup();
    }
  });

  it("detects a file created inside the bundle after preparation", async () => {
    const bundle = await prepareDisposableReviewBundle({
      reviewRequestId: "r1", requestHash: "a".repeat(64), materialJson: "{}", verdictJsonSchema: {}, promptText: "prompt"
    });
    try {
      await writeFile(path.join(bundle.bundlePath, "unexpected.txt"), "mutation");
      expect(await bundle.verifyUnchanged()).toBe(false);
    } finally {
      await bundle.cleanup();
    }
  });

  it("detects a modification to an existing bundle file", async () => {
    const bundle = await prepareDisposableReviewBundle({
      reviewRequestId: "r1", requestHash: "a".repeat(64), materialJson: "{}", verdictJsonSchema: {}, promptText: "prompt"
    });
    try {
      await writeFile(path.join(bundle.bundlePath, "prompt.txt"), "tampered");
      expect(await bundle.verifyUnchanged()).toBe(false);
    } finally {
      await bundle.cleanup();
    }
  });

  it("cleanup removes the bundle directory entirely", async () => {
    const bundle = await prepareDisposableReviewBundle({
      reviewRequestId: "r1", requestHash: "a".repeat(64), materialJson: "{}", verdictJsonSchema: {}, promptText: "prompt"
    });
    await bundle.cleanup();
    expect(await exists(bundle.bundlePath)).toBe(false);
  });
});
