// src/platform/fs_retry.ts
//
// Windows fix: a plain `rmSync(path, { recursive: true, force: true })`
// with no retry options has zero built-in resilience to a transient
// file-lock. On Windows, deleting a file (or a directory containing one)
// immediately after closing it — a SQLite WAL/SHM handle, a file a child
// process (tsc, a test runner) just exited but the OS hasn't fully
// released, or a file Windows Defender/Search Indexer is scanning the
// instant it's written — routinely throws EPERM even though nothing in
// the calling process still holds the handle. This is a known, common
// Node-on-Windows failure mode, not a bug specific to any one caller.
//
// Node's fs.rmSync already has first-class support for this: passing
// `maxRetries`/`retryDelay` makes it retry with linear backoff on EBUSY,
// EMFILE, ENFILE, ENOTEMPTY, and EPERM specifically — but only when
// `recursive: true` is also set, and only if the caller opts in. Nothing
// in this codebase was opting in, so every one of these transient races
// surfaced as a hard failure instead of self-healing a few hundred
// milliseconds later.
//
// Use this instead of calling `rmSync` directly anywhere cleanup follows
// a just-closed file handle or a just-exited child process — that's
// every temp-dir teardown in this repo's tests, plus the sandbox and
// scaffold/modify rollback paths in production code.
import { rmSync, type RmOptions } from "node:fs";

const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_RETRY_DELAY_MS = 100;

/**
 * `rmSync` with Windows-safe retry defaults baked in. Swallows the final
 * failure by default (`force: true`, matching every existing call site's
 * intent of "best-effort cleanup, don't let teardown mask the real
 * error") — pass `{ force: false }` if a caller genuinely needs deletion
 * failures to throw.
 */
export function safeRmSync(path: string, options: RmOptions = {}): void {
  const opts: RmOptions = {
    recursive: true,
    force: true,
    maxRetries: DEFAULT_MAX_RETRIES,
    retryDelay: DEFAULT_RETRY_DELAY_MS,
    ...options,
  };
  try {
    rmSync(path, opts);
  } catch {
    // Best-effort: if it's still locked after every retry, leaving a
    // stray temp file/dir behind is far better than crashing whatever
    // real error or result the caller was already returning.
  }
}
