// src/cli/failure_text.ts
//
// H5: the message shown after "🛑" for a failed command. A failure caused by a full disk, or by a lock another Purix process holds, says so, in one sentence that names the
// way out; the original text follows it, so a bug report still has the exact error. Everything else is unchanged.
import { homedir } from "node:os";
import { isDatabaseBusy, DATABASE_BUSY_SENTENCE } from "@purix/core/platform/db_busy";
import { isDiskFull, freeBytes, DISK_FULL_SENTENCE, type FreeBytesFn } from "@purix/core/platform/disk_full";

export function failureMessage(err: unknown, dirs: readonly string[] = [process.cwd(), homedir()], free: FreeBytesFn = freeBytes): string {
  const message = err instanceof Error ? err.message : String(err);
  if (isDatabaseBusy(message)) return `${DATABASE_BUSY_SENTENCE}\n   (${message})`;
  return dirs.some((d) => isDiskFull(message, d, free)) ? `${DISK_FULL_SENTENCE}\n   (${message})` : message;
}
