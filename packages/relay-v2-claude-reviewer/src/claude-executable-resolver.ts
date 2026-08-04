import { open, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

/** Never trusted as an executable regardless of what RELAY_V2_CLAUDE_PATH or a resolved shim target claims -- these are interpreter/script extensions, not a native binary this process can safely spawn with `shell:false`. */
const FORBIDDEN_EXTENSIONS = new Set([".cmd", ".bat", ".ps1", ".sh", ".js", ".mjs", ".cjs"]);

/** Windows DOS header magic ("MZ") and PE signature ("PE\0\0"), checked at the e_lfanew offset recorded in the DOS header. A pure structural check -- no external dependency -- sufficient to reject a text/script file masquerading with a `.exe` name. */
const DOS_MAGIC = Buffer.from([0x4d, 0x5a]);
const PE_SIGNATURE = Buffer.from([0x50, 0x45, 0x00, 0x00]);

export type NativeExecutableRejectionReason =
  | "NOT_ABSOLUTE"
  | "NOT_FOUND"
  | "NOT_A_REGULAR_FILE"
  | "FORBIDDEN_EXTENSION"
  | "UNEXPECTED_BASENAME"
  | "MALFORMED_PE"
  | "EMPTY_FILE";

export type NativeExecutableValidation = { ok: true; realPath: string } | { ok: false; reason: NativeExecutableRejectionReason };

/**
 * On win32, requires the file to be a structurally valid native PE
 * executable (DOS header + PE signature at the header's own recorded
 * offset) -- this alone rejects any text file, script, or malformed binary
 * dropped in with a `.exe` extension. Not a full PE parser: it does not
 * validate the optional header, section table, or machine type, only the
 * two magic markers every real PE image begins with.
 */
async function looksLikeNativePe(filePath: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(filePath, "r");
    const header = Buffer.alloc(64);
    const { bytesRead } = await handle.read(header, 0, 64, 0);
    if (bytesRead < 64 || !header.subarray(0, 2).equals(DOS_MAGIC)) return false;
    const peOffset = header.readUInt32LE(0x3c);
    if (peOffset < 64 || peOffset > 16 * 1024 * 1024) return false;
    const signature = Buffer.alloc(4);
    const { bytesRead: signatureBytesRead } = await handle.read(signature, 0, 4, peOffset);
    return signatureBytesRead === 4 && signature.equals(PE_SIGNATURE);
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

const EXPECTED_BASENAME = process.platform === "win32" ? "claude.exe" : "claude";

/**
 * Validates that `candidatePath` is a canonical, absolute, regular, non-empty
 * file with an expected basename (`claude` or `claude.exe`, case-insensitive
 * -- never a `.cmd`/`.bat`/`.ps1`/`.sh`/`.js`/`.mjs`/`.cjs` script, and never
 * anything else), and -- on win32 -- a structurally valid native PE image.
 * This runs on every resolved candidate (RELAY_V2_CLAUDE_PATH override, a
 * direct PATH hit, and a shim's recovered target alike): an operator override
 * is still not permitted to authorize an arbitrary existing file. Symlinks
 * and Windows reparse points are followed to their real, final target via
 * `realpath` before any check below runs, so validation always applies to
 * what would actually be executed, not to the link itself.
 */
export async function validateNativeClaudeExecutable(candidatePath: string): Promise<NativeExecutableValidation> {
  if (!path.isAbsolute(candidatePath)) return { ok: false, reason: "NOT_ABSOLUTE" };
  let realPath: string;
  try {
    realPath = await realpath(candidatePath);
  } catch {
    return { ok: false, reason: "NOT_FOUND" };
  }
  const extension = path.extname(realPath).toLowerCase();
  if (FORBIDDEN_EXTENSIONS.has(extension)) return { ok: false, reason: "FORBIDDEN_EXTENSION" };
  const basename = path.basename(realPath).toLowerCase();
  if (basename !== EXPECTED_BASENAME) return { ok: false, reason: "UNEXPECTED_BASENAME" };
  let info;
  try {
    info = await stat(realPath);
  } catch {
    return { ok: false, reason: "NOT_FOUND" };
  }
  if (!info.isFile()) return { ok: false, reason: "NOT_A_REGULAR_FILE" };
  if (info.size === 0) return { ok: false, reason: "EMPTY_FILE" };
  if (process.platform === "win32") {
    if (!(await looksLikeNativePe(realPath))) return { ok: false, reason: "MALFORMED_PE" };
  }
  return { ok: true, realPath };
}

async function existingValidatedFile(candidate: string): Promise<string | undefined> {
  const result = await validateNativeClaudeExecutable(candidate);
  return result.ok ? result.realPath : undefined;
}

/**
 * npm's Windows cmd-shim/ps1-shim generator always emits this exact relative
 * reference (verified locally against the installed `claude.cmd`/`claude.ps1`):
 * `%dp0%\node_modules\@anthropic-ai\claude-code\bin\claude.exe`. This is a
 * generic npm bin-shim convention, not something specific to Claude, so
 * parsing it statically (never executing the shim) is a safe, verifiable way
 * to resolve the real native binary a shim points at. The shim file itself is
 * only ever text-parsed here -- it is never passed to SafeProcessRunner, and
 * its recovered target is independently re-validated as a native executable
 * before being trusted (see validateNativeClaudeExecutable above).
 */
const SHIM_TARGET_PATTERN = /node_modules[\\/]@anthropic-ai[\\/]claude-code[\\/]bin[\\/]claude\.exe/;

async function resolveWindowsShim(shimPath: string): Promise<string | undefined> {
  let contents: string;
  try {
    contents = await readFile(shimPath, "utf8");
  } catch {
    return undefined;
  }
  const match = SHIM_TARGET_PATTERN.exec(contents);
  if (!match) return undefined;
  // The shim always resolves the target relative to its own directory
  // (`%~dp0%`/`$basedir`), never via an absolute or environment-derived path.
  const candidate = path.join(path.dirname(shimPath), match[0]);
  return existingValidatedFile(candidate);
}

/**
 * Resolves an absolute, real, existing, structurally-validated native Claude
 * Code executable -- never a `.cmd`/`.ps1` shim, script, directory, relative
 * path, or malformed/non-PE binary, and never something that would require
 * shell interpretation (a "shell true" launch mode) to invoke. Resolution
 * order:
 *   1. `RELAY_V2_CLAUDE_PATH` (operator override) -- the only place request
 *      input could ever indirectly reach; never taken from an API request.
 *      Still fully re-validated below: an override cannot authorize an
 *      arbitrary existing file.
 *   2. A `claude.exe` (win32) / `claude` (posix) directly on PATH -- covers a
 *      standalone native install and, on posix, a real npm global install
 *      (where the PATH entry is a symlink to the real binary; realpath
 *      already follows it).
 *   3. Windows only: a `claude.cmd`/`claude.ps1` npm shim found on PATH,
 *      whose static text is parsed (never executed) to recover the real
 *      binary path it references, which must independently exist and pass
 *      the same native-executable validation as every other candidate.
 * Returns undefined, never a guess, if nothing verifiably resolves.
 */
export class ClaudeExecutableResolver {
  constructor(private readonly environment: NodeJS.ProcessEnv = process.env) {}

  async findExecutable(): Promise<string | undefined> {
    const configured = this.environment.RELAY_V2_CLAUDE_PATH;
    if (configured) return existingValidatedFile(configured);

    const pathDirectories = (this.environment.PATH ?? "").split(path.delimiter).filter(Boolean);
    const directName = process.platform === "win32" ? "claude.exe" : "claude";
    for (const directory of pathDirectories) {
      const found = await existingValidatedFile(path.join(directory, directName));
      if (found) return found;
    }

    if (process.platform === "win32") {
      for (const directory of pathDirectories) {
        for (const shimName of ["claude.cmd", "claude.ps1"]) {
          const resolved = await resolveWindowsShim(path.join(directory, shimName));
          if (resolved) return resolved;
        }
      }
    }
    return undefined;
  }
}
