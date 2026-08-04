import { z } from "zod";

/**
 * Strict unified-diff HEADER parsing, for proving which files a patch actually
 * evidences.
 *
 * The defect this replaces: coverage was decided with
 * `unifiedDiff.includes(file.path)`. A path string occurring anywhere in the
 * diff satisfied that test -- including inside another file's hunk BODY. A
 * change that deletes the line `import x from "src/secret.ts"` from some other
 * file therefore "covered" `src/secret.ts`, and a changed file with no diff of
 * its own passed the coverage gate on the strength of an unrelated file's
 * content. Coverage must be derived from the diff's own structure, never from
 * its text.
 *
 * Only these header forms declare a path here:
 *   - `diff --git a/<old> b/<new>`
 *   - `--- a/<old>` / `--- /dev/null`
 *   - `+++ b/<new>` / `+++ /dev/null`
 *   - `rename from <path>` / `rename to <path>`
 *
 * Hunk bodies (` `, `+`, `-`, `\`) and hunk ranges (`@@`) are never inspected
 * for paths. A malformed header, a traversal path, an absolute path, or two
 * header blocks claiming the same path are hard failures: an unparseable diff
 * proves nothing, and silently treating it as "covers nothing" (or "covers
 * everything") would both be worse than refusing it.
 *
 * Within one block every header must name the SAME identity, because a block
 * whose headers contradict each other proves nothing about either path it
 * mentions:
 *   - modification: `diff --git` old/new must agree with `---`/`+++`;
 *   - addition: the old side may be `/dev/null`, and the new path must agree
 *     across `diff --git` and `+++`;
 *   - deletion: the new side may be `/dev/null`, and the old path must agree
 *     across `diff --git` and `---`;
 *   - rename: `rename from`/`rename to` are required together, must equal the
 *     `diff --git` old/new paths exactly, and must equal any `---`/`+++`
 *     headers present.
 */

export const UNIFIED_DIFF_PARSER_VERSION = "unified-diff-parser-v1" as const;

/** The conventional "this side does not exist" marker for an added or deleted file. */
const DEV_NULL = "/dev/null";

export const unifiedDiffFileChangeSchema = z.object({
  /** Normalized path on the pre-image side; null for an added file. */
  oldPath: z.string().nullable(),
  /** Normalized path on the post-image side; null for a deleted file. */
  newPath: z.string().nullable(),
  changeKind: z.enum(["ADDED", "DELETED", "MODIFIED", "RENAMED"])
}).strict();
export type UnifiedDiffFileChange = z.infer<typeof unifiedDiffFileChangeSchema>;

export type UnifiedDiffParseResult =
  | { ok: true; files: UnifiedDiffFileChange[]; paths: string[] }
  | { ok: false; reason: string };

/** Normalizes separators only. Never resolves, never rewrites segments -- a `..` segment is rejected, not collapsed. */
function normalizeSeparators(value: string): string {
  return value.replace(/\\/g, "/");
}

function isUnsafePath(value: string): boolean {
  if (!value.length) return true;
  if (/^([a-zA-Z]:)?\//.test(value)) return true;
  return value.split("/").includes("..");
}

/**
 * Strips the conventional `a/` or `b/` prefix from a `---`/`+++`/`diff --git`
 * operand. A quoted operand (git's C-style quoting for a path containing
 * spaces or non-ASCII bytes) is NOT supported and is rejected rather than
 * being decoded approximately: an approximate path is exactly the kind of
 * value that must never silently satisfy a coverage proof.
 */
function stripPrefix(operand: string, expected: "a" | "b"): { ok: true; path: string | null } | { ok: false; reason: string } {
  if (operand === DEV_NULL) return { ok: true, path: null };
  if (operand.startsWith('"')) {
    return { ok: false, reason: `unified diff declares a quoted path (${operand}), which this parser does not decode; the patch cannot prove coverage.` };
  }
  const prefix = `${expected}/`;
  if (!operand.startsWith(prefix)) {
    return { ok: false, reason: `unified diff header operand '${operand}' does not carry the expected '${prefix}' prefix.` };
  }
  const path = normalizeSeparators(operand.slice(prefix.length));
  if (isUnsafePath(path)) return { ok: false, reason: `unified diff header declares an unsafe path '${path}'.` };
  return { ok: true, path };
}

type PendingBlock = {
  gitOld: string | null;
  gitNew: string | null;
  minusPath: string | null;
  plusPath: string | null;
  sawMinus: boolean;
  sawPlus: boolean;
  renameFrom: string | null;
  renameTo: string | null;
};

function newBlock(gitOld: string | null, gitNew: string | null): PendingBlock {
  return { gitOld, gitNew, minusPath: null, plusPath: null, sawMinus: false, sawPlus: false, renameFrom: null, renameTo: null };
}

function finishBlock(block: PendingBlock): { ok: true; file: UnifiedDiffFileChange } | { ok: false; reason: string } {
  if (block.renameFrom !== null || block.renameTo !== null) {
    if (block.renameFrom === null || block.renameTo === null) {
      return { ok: false, reason: "unified diff declares a rename with only one of 'rename from'/'rename to'." };
    }
    // Rename metadata never gets to name a DIFFERENT file than the block it
    // sits in. `diff --git a/real.ts b/real.ts` followed by `rename from
    // missing.ts` / `rename to target.ts` used to "cover" missing.ts and
    // target.ts on the strength of the rename headers alone -- so a changed
    // file with no diff of its own could satisfy exact path coverage from a
    // block that contradicts itself. Every path a rename block claims must be
    // claimed identically by every header in that block.
    if (block.gitOld === null || block.gitNew === null) {
      return { ok: false, reason: `unified diff declares rename metadata ('${block.renameFrom}' -> '${block.renameTo}') in a block whose 'diff --git' header does not name both sides.` };
    }
    if (block.renameFrom !== block.gitOld) {
      return { ok: false, reason: `unified diff 'rename from' path '${block.renameFrom}' disagrees with its 'diff --git' old path '${block.gitOld}'.` };
    }
    if (block.renameTo !== block.gitNew) {
      return { ok: false, reason: `unified diff 'rename to' path '${block.renameTo}' disagrees with its 'diff --git' new path '${block.gitNew}'.` };
    }
    if (block.renameFrom === block.renameTo) {
      return { ok: false, reason: `unified diff declares a rename whose two sides are the same path '${block.renameFrom}'.` };
    }
    if (block.sawMinus !== block.sawPlus) {
      return { ok: false, reason: "unified diff rename block has a '---' header without a matching '+++' header (or the reverse)." };
    }
    if (block.sawMinus && block.minusPath !== block.renameFrom) {
      return { ok: false, reason: `unified diff rename block's '---' header path '${block.minusPath ?? DEV_NULL}' disagrees with its 'rename from' path '${block.renameFrom}'.` };
    }
    if (block.sawPlus && block.plusPath !== block.renameTo) {
      return { ok: false, reason: `unified diff rename block's '+++' header path '${block.plusPath ?? DEV_NULL}' disagrees with its 'rename to' path '${block.renameTo}'.` };
    }
    return { ok: true, file: { oldPath: block.renameFrom, newPath: block.renameTo, changeKind: "RENAMED" } };
  }

  // `diff --git` alone (a pure mode change, say) declares both sides; a
  // `---`/`+++` pair overrides it, and the two must not disagree.
  const oldPath = block.sawMinus ? block.minusPath : block.gitOld;
  const newPath = block.sawPlus ? block.plusPath : block.gitNew;
  if (block.sawMinus !== block.sawPlus) {
    return { ok: false, reason: "unified diff file block has a '---' header without a matching '+++' header (or the reverse)." };
  }
  if (block.sawMinus && block.gitOld !== null && block.minusPath !== null && block.gitOld !== block.minusPath) {
    return { ok: false, reason: `unified diff 'diff --git' old path '${block.gitOld}' disagrees with its '---' header path '${block.minusPath}'.` };
  }
  if (block.sawPlus && block.gitNew !== null && block.plusPath !== null && block.gitNew !== block.plusPath) {
    return { ok: false, reason: `unified diff 'diff --git' new path '${block.gitNew}' disagrees with its '+++' header path '${block.plusPath}'.` };
  }
  if (oldPath === null && newPath === null) {
    return { ok: false, reason: "unified diff file block declares no path on either side." };
  }
  if (oldPath === null) return { ok: true, file: { oldPath: null, newPath, changeKind: "ADDED" } };
  if (newPath === null) return { ok: true, file: { oldPath, newPath: null, changeKind: "DELETED" } };
  if (oldPath !== newPath) return { ok: true, file: { oldPath, newPath, changeKind: "RENAMED" } };
  return { ok: true, file: { oldPath, newPath, changeKind: "MODIFIED" } };
}

/**
 * Parses every file block a unified diff declares, from its headers alone.
 *
 * An empty diff parses successfully with zero files -- "this patch evidences
 * nothing" is a legitimate, checkable statement, unlike "this patch could not
 * be understood", which is a failure.
 */
export function parseUnifiedDiff(diff: string): UnifiedDiffParseResult {
  const files: UnifiedDiffFileChange[] = [];
  let block: PendingBlock | null = null;
  let inHunk = false;

  const flush = (): { ok: true } | { ok: false; reason: string } => {
    if (!block) return { ok: true };
    const finished = finishBlock(block);
    block = null;
    if (!finished.ok) return finished;
    files.push(finished.file);
    return { ok: true };
  };

  for (const rawLine of diff.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

    if (line.startsWith("diff --git ")) {
      const flushed = flush();
      if (!flushed.ok) return flushed;
      inHunk = false;
      const operands = line.slice("diff --git ".length).split(" ");
      if (operands.length !== 2) {
        return { ok: false, reason: `unified diff 'diff --git' header is malformed: '${line}'.` };
      }
      const oldSide = stripPrefix(operands[0]!, "a");
      if (!oldSide.ok) return oldSide;
      const newSide = stripPrefix(operands[1]!, "b");
      if (!newSide.ok) return newSide;
      block = newBlock(oldSide.path, newSide.path);
      continue;
    }

    // Inside a hunk body, a line starting with '---'/'+++' is CONTENT (a
    // removed/added line that happens to begin with dashes or pluses), never a
    // header. Only a `@@` range or a new `diff --git` leaves that state.
    if (line.startsWith("@@")) {
      if (!block) return { ok: false, reason: "unified diff contains a hunk range with no preceding file header." };
      inHunk = true;
      continue;
    }

    if (!inHunk && line.startsWith("--- ")) {
      if (!block) block = newBlock(null, null);
      if (block.sawMinus) return { ok: false, reason: "unified diff file block declares two '---' headers." };
      const side = stripPrefix(line.slice(4).trim(), "a");
      if (!side.ok) return side;
      block.sawMinus = true;
      block.minusPath = side.path;
      continue;
    }

    if (!inHunk && line.startsWith("+++ ")) {
      if (!block) return { ok: false, reason: "unified diff declares a '+++' header with no preceding '---' header." };
      if (block.sawPlus) return { ok: false, reason: "unified diff file block declares two '+++' headers." };
      const side = stripPrefix(line.slice(4).trim(), "b");
      if (!side.ok) return side;
      block.sawPlus = true;
      block.plusPath = side.path;
      continue;
    }

    if (!inHunk && (line.startsWith("rename from ") || line.startsWith("rename to "))) {
      if (!block) return { ok: false, reason: "unified diff declares rename metadata with no preceding file header." };
      const isFrom = line.startsWith("rename from ");
      const operand = line.slice(isFrom ? "rename from ".length : "rename to ".length).trim();
      if (operand.startsWith('"')) return { ok: false, reason: "unified diff declares a quoted rename path, which this parser does not decode." };
      const path = normalizeSeparators(operand);
      if (isUnsafePath(path)) return { ok: false, reason: `unified diff rename metadata declares an unsafe path '${path}'.` };
      if (isFrom) {
        if (block.renameFrom !== null) return { ok: false, reason: "unified diff file block declares two 'rename from' headers." };
        block.renameFrom = path;
      } else {
        if (block.renameTo !== null) return { ok: false, reason: "unified diff file block declares two 'rename to' headers." };
        block.renameTo = path;
      }
      continue;
    }
  }

  const flushed = flush();
  if (!flushed.ok) return flushed;

  // Two blocks claiming the same path make coverage ambiguous: which block's
  // content evidences that file? Refused rather than resolved by precedence.
  const seen = new Set<string>();
  for (const file of files) {
    // A modified file names the same path on both sides; that is one block,
    // not two. Only a path claimed by a SECOND block is a conflict.
    const claimed = new Set([file.oldPath, file.newPath].filter((path): path is string => path !== null));
    for (const path of claimed) {
      if (seen.has(path)) return { ok: false, reason: `unified diff declares duplicate or conflicting file blocks for '${path}'.` };
      seen.add(path);
    }
  }
  return { ok: true, files, paths: [...seen].sort((left, right) => left.localeCompare(right)) };
}

/**
 * The exact set of normalized paths a diff evidences, for coverage checking.
 * A path counts only when a header names it -- never because it appears in
 * some other file's hunk content.
 */
export function unifiedDiffCoveredPaths(diff: string): { ok: true; paths: string[] } | { ok: false; reason: string } {
  const parsed = parseUnifiedDiff(diff);
  if (!parsed.ok) return parsed;
  return { ok: true, paths: parsed.paths };
}

/**
 * The exact section markers WorkspaceEvidenceService writes between the staged
 * and unstaged halves of a captured patch. Defined here, in the shared
 * contract, because the producer that emits them and the consumers that must
 * parse around them live in packages that may not import each other -- and a
 * marker that only one side knows about is a format only one side can read.
 *
 * They deliberately begin with `---`, which is also how a unified-diff
 * pre-image header begins, so a consumer MUST split on them explicitly rather
 * than feeding the composite text to a diff parser and hoping.
 */
export const RELAY_PATCH_STAGED_MARKER = "--- STAGED ---" as const;
export const RELAY_PATCH_UNSTAGED_MARKER = "--- UNSTAGED ---" as const;

/**
 * Parses Relay's composite staged+unstaged patch capture into the exact set of
 * paths its file headers evidence.
 *
 * A path may legitimately appear in BOTH sections (a file with staged and
 * unstaged changes), so a repeat ACROSS sections is normal and merges; a
 * repeat WITHIN one section is still the ambiguous duplicate-block case and is
 * still refused.
 */
export function parseRelayPatchPreview(text: string): { ok: true; paths: string[] } | { ok: false; reason: string } {
  const paths = new Set<string>();
  for (const section of splitRelayPatchSections(text)) {
    const parsed = parseUnifiedDiff(section);
    if (!parsed.ok) return parsed;
    for (const path of parsed.paths) paths.add(path);
  }
  return { ok: true, paths: [...paths].sort((left, right) => left.localeCompare(right)) };
}

/** Splits on the exact marker LINES only -- never on a diff body line that merely starts the same way. */
function splitRelayPatchSections(text: string): string[] {
  const sections: string[] = [];
  let current: string[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line === RELAY_PATCH_STAGED_MARKER || line === RELAY_PATCH_UNSTAGED_MARKER) {
      sections.push(current.join("\n"));
      current = [];
      continue;
    }
    current.push(rawLine);
  }
  sections.push(current.join("\n"));
  return sections.filter(section => section.trim().length > 0);
}
