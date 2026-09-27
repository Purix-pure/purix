// src/llm/sqlite_retry.ts
//
// Security fix (review finding #3): llm/budget.ts and llm/circuit.ts used to
// keep their state in standalone JSON files with a plain read-mutate-write
// cycle, with none of the concurrency protection manifest/store.ts already
// has for exactly this reason. Two concurrent `purix modify` invocations —
// which the architecture explicitly allows for — could each read the same
// total_spent_usd, add their own call's cost on top of the same stale
// number, and have the second write clobber the first, silently defeating
// the $5 hard ceiling.
//
// Fix: both budget and circuit state now live in the same SQLite database
// as the manifest (manifest/store.ts's getDb()), and every write is a
// single atomic UPDATE statement (increment-in-SQL, not read-then-write),
// so there is no window between "read the old value" and "write the new
// one" for a second process to land in. This helper adds retry-with-backoff
// for SQLITE_BUSY on top of that, since WAL mode still means only one
// writer at a time across separate connections.
//
// node:sqlite is a synchronous API, unlike manifest/store.ts's async
// retry helper (which waits on real LLM network calls elsewhere) — so this
// uses platform/sleep_sync.ts's Atomics-based sleepSync rather than
// await/setTimeout (see that file for why a true synchronous sleep is
// needed here and how it's implemented on Node).
import { sleepSync } from "../platform/sleep_sync.js";

// Thrown when every retry attempt still hit contention (SQLITE_BUSY /
// "database is locked", or SQLITE_IOERR / "disk I/O error" — see the
// isRetryableSqliteError() comment below for why both count) — i.e.
// contention never cleared within the retry budget. This is a distinct,
// catchable type specifically so callers like assertBudgetAvailable can
// tell "genuinely still busy after retrying" apart from any other SQLite
// error, and fold it into their own normal "can't proceed right now"
// result instead of letting a raw driver error escape as an unhandled
// crash. Under real multi-process contention (verified via
// budget_worktree.test.ts) this is a reachable, expected outcome, not a
// bug on its own — only leaving it unhandled was the bug.
export class SqliteRetryExhaustedError extends Error {
  constructor(label: string, attempts: number, cause: unknown) {
    super(`${label}: still busy after ${attempts} attempts`);
    this.name = "SqliteRetryExhaustedError";
    this.cause = cause;
  }
}

// BUG FIX (observed directly: budget_worktree.test.ts failing with a raw
// "disk I/O error" instead of the expected guardrail/SqliteRetryExhausted
// result): this used to only match /SQLITE_BUSY|database is locked/i.
// Those two cover node:sqlite's own busy-handler error, but WAL mode under
// real multi-process contention — several processes racing to write the
// same WAL file, which is exactly what budget_worktree.test.ts does on
// purpose — can also surface as SQLITE_IOERR ("disk I/O error"), especially
// on Windows where file-locking semantics are looser than POSIX. That
// error shape isn't a busy-handler timeout, but it's the same underlying
// situation (transient contention on this same database, not a real disk
// fault) and this file's whole job is to turn "transient contention" into
// a retry — so it belongs in the same bucket rather than escaping as an
// unhandled crash the one time it shows up in this particular shape.
function isRetryableSqliteError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /SQLITE_BUSY|database is locked|SQLITE_IOERR|disk I\/O error/i.test(message);
}

export function withSqliteRetry<T>(fn: () => T, label: string, maxAttempts = 5): T {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return fn();
    } catch (err: any) {
      if (!isRetryableSqliteError(err)) throw err;
      if (attempt === maxAttempts) throw new SqliteRetryExhaustedError(label, maxAttempts, err);
      const waitMs = 50 * 2 ** (attempt - 1);
      console.log(`  [${label}] retryable SQLite contention — retrying in ${waitMs}ms (attempt ${attempt}/${maxAttempts})`);
      sleepSync(waitMs);
    }
  }
  // Unreachable — loop above always returns or throws.
  throw new Error(`${label}: retry loop exited without returning`);
}