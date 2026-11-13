// src/entrypoints/modify.ts
import { readFile, writeFile, unlink } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ManifestEntry } from "../manifest/schema.js";
import { atomicWriteFile } from "../platform/atomic_write.js";
import { resolveSafePath } from "../gates/path_guard.js";

export interface FileContent {
  path: string;
  content: string;
}

export interface FileBackup {
  path: string;
  fullPath: string;
  previousContent: string;
  /** False when the change added this file (there was nothing to back up), so a rollback deletes it. Absent means true. */
  existed?: boolean;
}

/** Nothing was written: the writer refused before touching any file, or undid what it had written. */
export class WriteAbortedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WriteAbortedError";
  }
}

export interface ApplyModificationOptions {
  /**
   * What each file held when the change was verified (the journal's before snapshot). A file whose content on disk now differs,
   * or that exists although the change expected to add it, was changed by someone else since: the write is refused, and a
   * person's edit is never overwritten. Checked for every file before the first write and again for each file immediately
   * before it is written. A path that is not listed is expected not to exist yet. Absent: no check (callers that never verified).
   */
  expectedBefore?: FileContent[];
  /** Called before the first write and before every file's write; throws to stop (the repository lock is no longer held). */
  lockCheck?: () => void;
}

/** The default writer: replace the file atomically (temp file, fsync, rename), keeping the permission bits of a file it replaces. */
const atomicWriter = ((path: string, data: string): Promise<void> => {
  try {
    atomicWriteFile(String(path), data);
    return Promise.resolve();
  } catch (err) {
    return Promise.reject(err instanceof Error ? err : new Error(String(err)));
  }
}) as unknown as typeof writeFile;

async function readOrNull(fullPath: string): Promise<string | null> {
  try {
    return await readFile(fullPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw err;
  }
}

export async function readComponentFiles(
  entry: ManifestEntry,
  targetDir: string = process.cwd()
): Promise<FileContent[]> {
  const files: FileContent[] = [];
  for (const relPath of entry.files ?? []) {
    const fullPath = join(targetDir, relPath);
    try {
      const content = await readFile(fullPath, "utf-8");
      files.push({ path: relPath, content });
    } catch {
      console.warn(`  warning: ${relPath} listed in manifest but not found on disk, skipping`);
    }
  }
  return files;
}

/**
 * Backs up every file's original content BEFORE writing any of them.
 * If a write fails partway through (disk full, permissions, whatever),
 * it now rolls back whatever it already wrote before re-throwing —
 * previously a mid-loop failure threw straight out of the function with
 * no backups returned, leaving a half-written component with no way to
 * undo it.
 *
 * `writeFileImpl` is injectable (defaulting to the real fs/promises
 * writeFile) purely for testability, following the same pattern
 * language/provider-kit.ts's `runFn` parameter already uses — the
 * rollback-fails-too path (GAPS-REPORT-2 §3) needs a file that writes
 * successfully on the first pass and fails specifically on rollback,
 * which isn't something a real filesystem can be made to do
 * deterministically (chmod-based read-only doesn't block a root-owned
 * process, and anything that does block root, like chattr +i, can't be
 * toggled mid-function without racing the very code under test).
 */
export async function applyModificationFiles(
  changes: { path: string; new_content: string; /** Remove the file instead of writing it. Rolled back by writing its previous content again. */ delete?: boolean }[],
  targetDir: string = process.cwd(),
  writeFileImpl: typeof writeFile = atomicWriter,
  options: ApplyModificationOptions = {}
): Promise<FileBackup[]> {
  const expected = options.expectedBefore ? new Map(options.expectedBefore.map((f) => [f.path, f.content])) : null;
  const changedSince = (path: string, onDisk: string | null): boolean => {
    if (!expected) return false;
    const was = expected.get(path);
    return was === undefined ? onDisk !== null : onDisk !== was;
  };
  const abort = (paths: string[]): WriteAbortedError =>
    new WriteAbortedError(
      `${paths.join(", ")} changed since it was verified (someone edited it, or created it, after the check), so nothing was overwritten. Run the command again against the current files.`
    );

  options.lockCheck?.();

  for (const change of changes) {
    const safe = resolveSafePath(targetDir, change.path);
    if (!safe.ok) throw new WriteAbortedError(`${change.path}: ${safe.reason}. Nothing was written.`);
  }

  // Back up every file's original content BEFORE writing any of them. A file the change adds has no original (existed: false).
  const backups: FileBackup[] = [];
  const moved: string[] = [];
  for (const change of changes) {
    const fullPath = join(targetDir, change.path);
    const previous = await readOrNull(fullPath);
    if (changedSince(change.path, previous)) moved.push(change.path);
    backups.push({ path: change.path, fullPath, previousContent: previous ?? "", ...(previous === null ? { existed: false } : {}) });
  }
  if (moved.length > 0) throw abort(moved);

  const written: FileBackup[] = [];
  try {
    for (let i = 0; i < changes.length; i++) {
      const backup = backups[i];
      const change = changes[i];
      if (backup && change) {
        options.lockCheck?.();
        // The check that matters most is the one made last: right before this file is replaced.
        if (changedSince(change.path, await readOrNull(backup.fullPath))) throw abort([change.path]);
        if (change.delete) {
          await unlinkIfPresent(backup.fullPath);
        } else {
          if (backup.existed === false) mkdirSync(dirname(backup.fullPath), { recursive: true });
          await writeFileImpl(backup.fullPath, change.new_content, "utf-8");
        }
        written.push(backup);
      }
    }
  } catch (err) {
    // BUG FIX (GAPS-REPORT-2 §3): rollback writes here used to be
    // fire-and-forget (`.catch(() => {})`), silently discarding any
    // failure. If the same condition that broke the original write
    // (disk full, a permissions change mid-run, a filesystem gone
    // read-only) also breaks the rollback, the caller previously saw
    // only the original write error and had no idea some files were
    // never restored — a component now sitting on disk in a partially
    // new, partially old, internally inconsistent state, indistinguishable
    // from a clean rollback. Track every rollback failure and, if any
    // occurred, surface them loudly alongside the original error instead
    // of silently discarding the one signal that manual recovery is
    // needed.
    const rollbackFailures: { path: string; reason: string }[] = [];
    for (const b of written) {
      try {
        if (b.existed === false) await unlinkIfPresent(b.fullPath);
        else {
          mkdirSync(dirname(b.fullPath), { recursive: true });
          await writeFileImpl(b.fullPath, b.previousContent, "utf-8");
        }
      } catch (rollbackErr) {
        rollbackFailures.push({
          path: b.path,
          reason: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
        });
      }
    }
    if (rollbackFailures.length > 0) {
      const originalMessage = err instanceof Error ? err.message : String(err);
      const detail = rollbackFailures.map((f) => `${f.path} (${f.reason})`).join(", ");
      const compositeErr = new Error(
        `Write failed (${originalMessage}) AND rollback failed for ${rollbackFailures.length} file(s) — these files are now in a partially-written, inconsistent state and need manual recovery: ${detail}`
      );
      (compositeErr as Error & { cause?: unknown; rollbackFailures?: typeof rollbackFailures }).cause = err;
      (compositeErr as Error & { cause?: unknown; rollbackFailures?: typeof rollbackFailures }).rollbackFailures = rollbackFailures;
      throw compositeErr;
    }
    throw err;
  }

  return backups;
}

async function unlinkIfPresent(fullPath: string): Promise<void> {
  try {
    await unlink(fullPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
  }
}

export async function rollbackModification(backups: FileBackup[]): Promise<void> {
  for (const b of backups) {
    if (b.existed === false) await unlinkIfPresent(b.fullPath);
    else {
      mkdirSync(dirname(b.fullPath), { recursive: true });
      atomicWriteFile(b.fullPath, b.previousContent);
    }
  }
}