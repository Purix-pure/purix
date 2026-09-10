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
 */
export async function applyModificationFiles(
  changes: { path: string; new_content: string }[],
  targetDir: string = process.cwd()
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
        await writeFile(backup.fullPath, change.new_content, "utf-8");
        written.push(backup);
      }
    }
  } catch (err) {
    for (const b of written) {
      await writeFile(b.fullPath, b.previousContent, "utf-8").catch(() => {});
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