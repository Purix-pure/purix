// packages/core/src/platform/atomic_write.ts
//
// PURIX-17 P1-B: the one way Purix writes a state file, and the one rule for reading one back.
//
// Write: temp file in the SAME directory, fsync, rename over the target. A crash leaves the old
// file or the new file, never half of one. On Windows, rename onto a file that something else has
// open fails transiently (EPERM/EBUSY/EACCES; antivirus and indexers do this), so the rename is
// retried with bounded backoff. Windows rename is not a true atomic replace in every case
// (npm's write-file-atomic history, 2016-2018), so on Windows this is "as safe as the platform
// allows", not a guarantee. On POSIX the containing directory is fsynced too, best effort.
//
// Read: one rule for missing, empty and corrupt files. A corrupt file is reported, never silently
// treated as "no data" by the reader; a caller that wants to carry on with defaults should first
// call quarantineCorruptFile() so the next write cannot destroy the evidence.
import { closeSync, copyFileSync, existsSync, fchmodSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

const RETRYABLE = new Set(["EPERM", "EBUSY", "EACCES"]);

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export interface AtomicWriteOptions {
  /** Rename retries on transient errors. Default 5. */
  retries?: number;
  /**
   * Permission bits for the new file (subject to the umask), set when the temp file is created, so a
   * sensitive file is never briefly readable with default permissions. POSIX only; ignored on Windows.
   * Default: the platform default (0o666).
   */
  mode?: number;
  /**
   * Apply `mode` exactly (fchmod on the temp file, before the rename) instead of letting the umask trim it. Without this a
   * file created with 0o775 under a 022 umask comes out 0o755. POSIX only; ignored on Windows. Default false, so every
   * existing caller keeps its behaviour. Set by atomicWriteFile when it carries a replaced file's mode over.
   */
  exactMode?: boolean;
  /**
   * Create the containing directory if it is missing. Default true. Pass false when the directory is itself a
   * lock or a claim that another process may remove: recreating it would resurrect a lock nobody holds. A missing
   * directory then fails with ENOENT instead.
   */
  mkdir?: boolean;
  /** Test seam: replace the rename step. */
  rename?: (from: string, to: string) => void;
  /** Test seam: replace the backoff wait. */
  sleep?: (ms: number) => void;
}

/** Writes content to a fresh temp file in `dir`, fsyncs it, returns its path. Removes it again if the write fails. */
function writeTempFile(dir: string, content: string, mode: number | undefined, mkdir = true, exactMode = false): string {
  if (mkdir) mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(tmp, "w", mode ?? 0o666);
  try {
    writeSync(fd, content, null, "utf-8");
    if (exactMode && mode !== undefined && process.platform !== "win32") fchmodSync(fd, mode);
    fsyncSync(fd);
  } catch (err) {
    try {
      closeSync(fd);
    } catch {
      // already closed
    }
    try {
      unlinkSync(tmp);
    } catch {
      // temp already gone
    }
    throw err;
  }
  closeSync(fd);
  return tmp;
}

export function writeFileAtomic(path: string, content: string, opts: AtomicWriteOptions = {}): void {
  const dir = dirname(path);
  const tmp = writeTempFile(dir, content, opts.mode, opts.mkdir ?? true, opts.exactMode ?? false);
  const doRename = opts.rename ?? renameSync;
  const wait = opts.sleep ?? sleepMs;
  const max = opts.retries ?? 5;
  for (let attempt = 0; ; attempt++) {
    try {
      doRename(tmp, path);
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (attempt >= max || !RETRYABLE.has(code)) {
        try {
          unlinkSync(tmp);
        } catch {
          // temp already gone
        }
        throw err;
      }
      wait(10 * 2 ** (attempt + 1));
    }
  }
  syncDirBestEffort(dir);
}

/**
 * A1 shared rail: the one way Purix replaces a USER's file (as opposed to one of its own state files).
 *
 * It is writeFileAtomic (temp file in the same directory, fsync, rename, bounded retry on Windows) plus one thing the state-file
 * writer never needed: when the target already exists, its permission bits are carried over exactly. Before this, replacing a
 * 0o755 script left it 0o644 (reproduced). `opts.mode` still wins when given. On Windows the mode is ignored, as before.
 *
 * What it does NOT do, on purpose, and which the caller (A3 owns the writer) must not assume:
 *  - It does not compare anything with what is on disk. The "unchanged since verification" re-check is the writer's job.
 *  - It does not follow a symlink. The rename replaces the link itself with a regular file inside the same directory, which can
 *    never write outside the repository. A path that may be a symlink must go through gates/path_guard.ts first.
 *  - It writes text (UTF-8, exactly as given: it adds and removes no newline).
 */
export function atomicWriteFile(path: string, content: string, opts: AtomicWriteOptions = {}): void {
  let mode = opts.mode;
  let exactMode = opts.exactMode ?? false;
  if (mode === undefined && process.platform !== "win32") {
    try {
      const st = lstatSync(path);
      if (st.isFile()) {
        mode = st.mode & 0o7777;
        exactMode = true;
      }
    } catch {
      // no existing file (or not readable): a new file gets the platform default
    }
  } else if (mode !== undefined) {
    exactMode = true;
  }
  writeFileAtomic(path, content, { ...opts, mode, exactMode });
}

export interface MoveAsideOptions {
  /** Retries on transient errors (EPERM/EBUSY/EACCES). Default 5. */
  retries?: number;
  /** Test seam: replace the rename step. */
  rename?: (from: string, to: string) => void;
  /** Test seam: replace the backoff wait. */
  sleep?: (ms: number) => void;
}

/**
 * Moves a file (or a damaged store) out of the way: `from` becomes `to`. The one rename primitive outside the
 * atomic writer (ratchet R5): used to quarantine a corrupt database and to claim an abandoned lock, where the
 * point is that only one process can win the rename. Retries transient Windows errors with bounded backoff;
 * any other error, including ENOENT (someone else already moved it), is thrown for the caller to judge.
 */
export function moveFileAside(from: string, to: string, opts: MoveAsideOptions = {}): void {
  const doRename = opts.rename ?? renameSync;
  const wait = opts.sleep ?? sleepMs;
  const max = opts.retries ?? 5;
  for (let attempt = 0; ; attempt++) {
    try {
      doRename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (attempt >= max || !RETRYABLE.has(code)) throw err;
      wait(10 * 2 ** (attempt + 1));
    }
  }
}

function syncDirBestEffort(dir: string): void {
  if (process.platform === "win32") return; // Windows cannot fsync a directory handle.
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Some filesystems refuse; the file itself is already fsynced.
  }
}

// Errors that mean "this filesystem or platform cannot make a hard link here", as opposed to "the target exists".
// EISDIR is here on purpose: on Windows, CreateHardLink fails with ERROR_INVALID_FUNCTION on exFAT/FAT32 and
// libuv maps that to EISDIR although neither path is a directory (nodejs/node#65817, observed on Node 24.19.0).
// A genuinely existing target is reported as EEXIST before this set is consulted, and the fallback below
// (open "wx") fails with EEXIST/EISDIR on its own if the target really is there or really is a directory.
// EXDEV cannot happen for a temp file in the same directory, but costs nothing to treat the same way.
const LINK_UNSUPPORTED = new Set(["EPERM", "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EISDIR", "EXDEV"]);

export interface ExclusiveCreateOptions {
  /** Permission bits for the new file (subject to the umask). POSIX only. */
  mode?: number;
  /** Test seam: replace the hard-link step. */
  link?: (existing: string, target: string) => void;
}

/**
 * Creates `path` with `content` only if nothing exists there. Returns true if this call created it, false if
 * something was already there (that file is left exactly as it was). Never overwrites.
 *
 * Why this exists: "check existsSync, then write" lets two processes both see "absent" and both write; the later
 * one silently wins. That is wrong for a lock (two holders) and for a generated secret (a second key that orphans
 * what the first encrypted). Creating the file is the one step the filesystem makes atomic and exclusive.
 *
 * How: the content is written to a temp file in the same directory and fsynced, then hard-linked to the target.
 * link() fails with EEXIST if the target exists, and when it succeeds the file appears complete, so a reader never
 * sees a half-written file (the failure that made a lock reader delete a live lock). If the filesystem cannot make
 * hard links (some network and FAT-family mounts), it falls back to open(path, "wx"), which is still exclusive but
 * not complete-on-appearance; a crash mid-write there can leave a partial file. Whether hard links work on every
 * Windows filesystem Purix meets is not established; the fallback exists for that reason and is only exercised in
 * tests through the `link` seam.
 */
export function createFileExclusive(path: string, content: string, opts: ExclusiveCreateOptions = {}): boolean {
  const tmp = writeTempFile(dirname(path), content, opts.mode);
  try {
    try {
      (opts.link ?? linkSync)(tmp, path);
      syncDirBestEffort(dirname(path));
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (code === "EEXIST") return false;
      if (!LINK_UNSUPPORTED.has(code)) throw err;
    }
    return createByOpenExclusive(path, content, opts.mode);
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // temp already gone
    }
  }
}

function createByOpenExclusive(path: string, content: string, mode: number | undefined): boolean {
  let fd: number;
  try {
    fd = openSync(path, "wx", mode ?? 0o666);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
  try {
    writeSync(fd, content, null, "utf-8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return true;
}

/** JSON with a stable layout, newline-terminated. */
export function writeJsonAtomic(path: string, value: unknown, opts: AtomicWriteOptions = {}): void {
  writeFileAtomic(path, JSON.stringify(value, null, 2) + "\n", opts);
}

export type JsonRead<T> = { kind: "missing" } | { kind: "ok"; value: T } | { kind: "corrupt"; error: string };

export function readJsonFile<T>(path: string): JsonRead<T> {
  if (!existsSync(path)) return { kind: "missing" };
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (err) {
    return { kind: "corrupt", error: err instanceof Error ? err.message : String(err) };
  }
  if (text.trim() === "") return { kind: "corrupt", error: "file is empty" };
  try {
    return { kind: "ok", value: JSON.parse(text) as T };
  } catch (err) {
    return { kind: "corrupt", error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Keeps a copy of a corrupt state file next to it (<name>.corrupt, replaced if one exists) so that
 * carrying on with defaults and then overwriting the file does not destroy the only evidence.
 * Returns the copy's path, or null if the copy could not be made. Never throws.
 */
export function quarantineCorruptFile(path: string): string | null {
  const dest = `${path}.corrupt`;
  try {
    copyFileSync(path, dest);
    return dest;
  } catch {
    return null;
  }
}
