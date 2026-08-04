import { describe, expect, it } from "vitest";
import { parseUnifiedDiff, unifiedDiffCoveredPaths } from "./unified-diff.js";

/**
 * Coverage must be provable from a diff's STRUCTURE, never from its text.
 *
 * The defect these tests pin: coverage was decided with
 * `unifiedDiff.includes(file.path)`, which any occurrence of the path string
 * satisfied -- including one inside a completely different file's hunk body.
 * A changed file whose diff was missing entirely could therefore be reported
 * as covered because some unrelated added line happened to mention it.
 */

describe("parseUnifiedDiff", () => {
  it("does NOT count a filename that appears only inside another file's added content", () => {
    const diff = [
      "diff --git a/src/loader.ts b/src/loader.ts",
      "--- a/src/loader.ts",
      "+++ b/src/loader.ts",
      "@@ -1,2 +1,3 @@",
      " import { boot } from \"./boot\";",
      "+import { secret } from \"src/secret.ts\";",
      "-const removed = require(\"src/removed.ts\");"
    ].join("\n");

    const parsed = parseUnifiedDiff(diff);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.paths).toEqual(["src/loader.ts"]);
    expect(parsed.paths).not.toContain("src/secret.ts");
    expect(parsed.paths).not.toContain("src/removed.ts");
  });

  it("counts a path named by an exact file header", () => {
    const parsed = unifiedDiffCoveredPaths("diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n+x\n");
    expect(parsed).toEqual({ ok: true, paths: ["src/a.ts"] });
  });

  it("parses an added file (/dev/null pre-image)", () => {
    const parsed = parseUnifiedDiff("diff --git a/new.ts b/new.ts\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1 @@\n+added\n");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.files).toEqual([{ oldPath: null, newPath: "new.ts", changeKind: "ADDED" }]);
    expect(parsed.paths).toEqual(["new.ts"]);
  });

  it("parses a deleted file (/dev/null post-image)", () => {
    const parsed = parseUnifiedDiff("diff --git a/gone.ts b/gone.ts\n--- a/gone.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.files).toEqual([{ oldPath: "gone.ts", newPath: null, changeKind: "DELETED" }]);
  });

  it("parses rename metadata and reports both sides", () => {
    const parsed = parseUnifiedDiff([
      "diff --git a/old/name.ts b/new/name.ts",
      "similarity index 98%",
      "rename from old/name.ts",
      "rename to new/name.ts"
    ].join("\n"));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.files).toEqual([{ oldPath: "old/name.ts", newPath: "new/name.ts", changeKind: "RENAMED" }]);
    expect(parsed.paths).toEqual(["new/name.ts", "old/name.ts"]);
  });

  /**
   * Rename metadata that contradicts its own block used to be believed on its
   * own terms: a block headed `diff --git a/real.ts b/real.ts` carrying
   * `rename from missing.ts` / `rename to target.ts` reported coverage of
   * missing.ts and target.ts -- neither of which that block evidences. A
   * changed file with no diff of its own could therefore pass exact path
   * coverage on the strength of a self-contradicting header pair.
   */
  describe("rename header consistency", () => {
    const renameBlock = (lines: readonly string[]) => parseUnifiedDiff(lines.join("\n"));

    it("rejects 'rename from' that disagrees with the block's 'diff --git' old path", () => {
      const parsed = renameBlock(["diff --git a/real.ts b/target.ts", "rename from missing.ts", "rename to target.ts"]);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.reason).toMatch(/'rename from' path 'missing.ts' disagrees/);
    });

    it("rejects the exact contradictory block that once satisfied coverage for a file it does not evidence", () => {
      const parsed = renameBlock(["diff --git a/real.ts b/real.ts", "rename from missing.ts", "rename to target.ts"]);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.reason).toMatch(/disagrees/);
      // The point of the rejection: neither contradicted path is ever reported.
      expect(unifiedDiffCoveredPaths("diff --git a/real.ts b/real.ts\nrename from missing.ts\nrename to target.ts\n").ok).toBe(false);
    });

    it("rejects 'rename to' that disagrees with the block's 'diff --git' new path", () => {
      const parsed = renameBlock(["diff --git a/old/name.ts b/new/name.ts", "rename from old/name.ts", "rename to elsewhere.ts"]);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.reason).toMatch(/'rename to' path 'elsewhere.ts' disagrees/);
    });

    it("rejects rename metadata that conflicts with the block's '---' header", () => {
      const parsed = renameBlock([
        "diff --git a/old/name.ts b/new/name.ts", "rename from old/name.ts", "rename to new/name.ts",
        "--- a/other.ts", "+++ b/new/name.ts"
      ]);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.reason).toMatch(/disagrees/);
    });

    it("rejects rename metadata that conflicts with the block's '+++' header", () => {
      const parsed = renameBlock([
        "diff --git a/old/name.ts b/new/name.ts", "rename from old/name.ts", "rename to new/name.ts",
        "--- a/old/name.ts", "+++ b/other.ts"
      ]);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.reason).toMatch(/disagrees/);
    });

    it("rejects a block with only 'rename from'", () => {
      const parsed = renameBlock(["diff --git a/old/name.ts b/new/name.ts", "rename from old/name.ts"]);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.reason).toMatch(/only one of 'rename from'\/'rename to'/);
    });

    it("rejects a block with only 'rename to'", () => {
      const parsed = renameBlock(["diff --git a/old/name.ts b/new/name.ts", "rename to new/name.ts"]);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.reason).toMatch(/only one of 'rename from'\/'rename to'/);
    });

    it("rejects rename metadata in a block whose 'diff --git' header does not name both sides", () => {
      const parsed = renameBlock(["--- a/old/name.ts", "+++ b/new/name.ts", "rename from old/name.ts", "rename to new/name.ts"]);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.reason).toMatch(/does not name both sides/);
    });

    it("rejects a rename whose two sides are the same path", () => {
      const parsed = renameBlock(["diff --git a/same.ts b/same.ts", "rename from same.ts", "rename to same.ts"]);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.reason).toMatch(/two sides are the same path/);
    });

    it("rejects an unsafe rename path rather than resolving it", () => {
      const parsed = renameBlock(["diff --git a/ok.ts b/moved.ts", "rename from ../../etc/passwd", "rename to moved.ts"]);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.reason).toMatch(/unsafe path/);
    });

    it("accepts a consistent rename that also carries agreeing '---'/'+++' headers", () => {
      const parsed = renameBlock([
        "diff --git a/old/name.ts b/new/name.ts", "similarity index 87%",
        "rename from old/name.ts", "rename to new/name.ts",
        "--- a/old/name.ts", "+++ b/new/name.ts", "@@ -1 +1 @@", "-old", "+new"
      ]);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.files).toEqual([{ oldPath: "old/name.ts", newPath: "new/name.ts", changeKind: "RENAMED" }]);
      expect(parsed.paths).toEqual(["new/name.ts", "old/name.ts"]);
    });
  });

  it("normalizes backslash separators without rewriting segments", () => {
    const parsed = parseUnifiedDiff("diff --git a/src\\win.ts b/src\\win.ts\n");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.paths).toEqual(["src/win.ts"]);
  });

  it("rejects a traversal path rather than resolving it", () => {
    const parsed = parseUnifiedDiff("diff --git a/../../etc/passwd b/../../etc/passwd\n");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toMatch(/unsafe path/);
  });

  it("rejects an absolute path", () => {
    expect(parseUnifiedDiff("diff --git a//etc/passwd b//etc/passwd\n").ok).toBe(false);
  });

  it("rejects a malformed `diff --git` header rather than guessing at its operands", () => {
    const parsed = parseUnifiedDiff("diff --git a/only-one-operand\n");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toMatch(/malformed/);
  });

  it("rejects a header operand without its conventional a//b/ prefix", () => {
    expect(parseUnifiedDiff("--- src/a.ts\n+++ b/src/a.ts\n").ok).toBe(false);
  });

  it("rejects a quoted path instead of decoding it approximately", () => {
    const parsed = parseUnifiedDiff('diff --git "a/has space.ts" "b/has space.ts"\n');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toMatch(/quoted path|malformed/);
  });

  it("rejects duplicate, conflicting file blocks for the same path", () => {
    const parsed = parseUnifiedDiff([
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "+one",
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "+two"
    ].join("\n"));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toMatch(/duplicate or conflicting/);
  });

  it("rejects a '---' header with no matching '+++' header", () => {
    expect(parseUnifiedDiff("diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n@@ -1 +1 @@\n+x\n").ok).toBe(false);
  });

  it("rejects a hunk range with no preceding file header", () => {
    expect(parseUnifiedDiff("@@ -1 +1 @@\n+orphan\n").ok).toBe(false);
  });

  it("rejects headers whose two sides disagree about the same block's path", () => {
    const parsed = parseUnifiedDiff("diff --git a/src/a.ts b/src/a.ts\n--- a/src/other.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n+x\n");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toMatch(/disagrees/);
  });

  it("treats an empty diff as evidencing nothing, which is a checkable statement rather than a failure", () => {
    expect(parseUnifiedDiff("")).toEqual({ ok: true, files: [], paths: [] });
  });

  it("parses several files and reports each exactly once", () => {
    const diff = ["src/a.ts", "src/b.ts", "src/c.ts"]
      .map(path => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n+edit\n`)
      .join("");
    const parsed = parseUnifiedDiff(diff);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.paths).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  });

  it("does not mistake hunk-body lines that begin with --- or +++ for headers", () => {
    const diff = [
      "diff --git a/notes.md b/notes.md",
      "--- a/notes.md",
      "+++ b/notes.md",
      "@@ -1,2 +1,2 @@",
      "-+++ b/impostor.md",
      "+--- a/impostor.md"
    ].join("\n");
    const parsed = parseUnifiedDiff(diff);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.paths).toEqual(["notes.md"]);
  });
});
