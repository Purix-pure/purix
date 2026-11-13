// src/platform/disk_full.ts
//
// H5: tells a full disk apart from a damaged store. SQLite reports a failed write on a full filesystem as "disk I/O error" (or
// "database or disk is full"), and node reports ENOSPC; before this file, read-only commands turned the first into "the local
// store is damaged", which sends a person to repair a store that is fine.
//
// The rule:
//   - a message that names a full disk or a quota (ENOSPC, EDQUOT, "no space left", "disk is full") is a full disk;
//   - a bare "disk I/O error" is a full disk only when the filesystem holding the directory has under 1 MiB free;
//   - any other message (malformed image, not a database, ...) is never a full disk, whatever the free space says;
//   - when the free space cannot be read, the answer for a bare I/O error is "no": no guess.
import { statfsSync } from "node:fs";
import { isDatabaseBusy } from "./db_busy.js";

/** Free space below this, on the filesystem that holds the store, is "full" for a bare I/O error. */
export const LOW_SPACE_BYTES = 1024 * 1024;

/** One sentence for every command that meets a full disk. It claims only what was tested: earlier state is not overwritten. */
export const DISK_FULL_SENTENCE =
  "The disk is full, so Purix could not read or write its state. Free some space and run the command again. Purix's earlier state was not overwritten.";

const NAMES_FULL_DISK = /\bENOSPC\b|\bEDQUOT\b|no space left|disk is full|SQLITE_FULL|disk quota/i;
const BARE_IO_ERROR = /disk I\/O error|SQLITE_IOERR/i;

export type FreeBytesFn = (dir: string) => number | null;

/** Free bytes for non-root users on the filesystem holding `dir`, or null when it cannot be read. */
export function freeBytes(dir: string): number | null {
  try {
    const s = statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

export function looksLikeDiskFull(message: string): boolean {
  return NAMES_FULL_DISK.test(message);
}

export function isDiskFull(message: string, dir: string, free: FreeBytesFn = freeBytes): boolean {
  if (looksLikeDiskFull(message)) return true;
  if (!BARE_IO_ERROR.test(message)) return false;
  const f = free(dir);
  return f !== null && f < LOW_SPACE_BYTES;
}

/** The phrase a read-only command puts after "Could not check:". Full disk is said as such; anything else stays "damaged". */
export function describeStoreProblem(detail: string, dir: string, free: FreeBytesFn = freeBytes): string {
  // H4: a store written by a newer Purix is not damaged. The phrase is NEWER_SCHEMA_PHRASE in manifest/schema_migrations.ts.
  if (/written by a newer Purix/.test(detail)) return `the local store was written by a newer Purix. Upgrade Purix, then run the command again.`;
  // H5: a lock held by another process is a wait, not damage.
  if (isDatabaseBusy(detail)) return "the local store is busy: another Purix process is using it. Wait a few seconds and run the command again.";
  return isDiskFull(detail, dir, free) ? "the local store could not be read because the disk is full." : `the local store is damaged (${detail}).`;
}
