// src/entrypoints/modify.ts
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ManifestEntry } from "../manifest/schema.js";

export interface FileContent {
  path: string;
  content: string;
}

export interface FileBackup {
  path: string;
  fullPath: string;
  previousContent: string;
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
  changes: { path: string; new_content: string }[],
  targetDir: string = process.cwd(),
  writeFileImpl: typeof writeFile = writeFile
): Promise<FileBackup[]> {
  const backups: FileBackup[] = [];
  for (const change of changes) {
    const fullPath = join(targetDir, change.path);
    const previousContent = await readFile(fullPath, "utf-8");
    backups.push({ path: change.path, fullPath, previousContent });
  }

  const written: FileBackup[] = [];
  try {
    for (let i = 0; i < changes.length; i++) {
      const backup = backups[i];
      const change = changes[i];
      if (backup && change) {
        await writeFileImpl(backup.fullPath, change.new_content, "utf-8");
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
        await writeFileImpl(b.fullPath, b.previousContent, "utf-8");
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

export async function rollbackModification(backups: FileBackup[]): Promise<void> {
  for (const b of backups) {
    await writeFile(b.fullPath, b.previousContent, "utf-8");
  }
}