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

// Thrown when every retry attempt still hit SQLITE_BUSY/"database is
// locked" — i.e. contention never cleared within the retry budget. This
// is a distinct, catchable type specifically so callers like
// assertBudgetAvailable can tell "genuinely still busy after retrying"
// apart from any other SQLite error, and fold it into their own normal
// "can't proceed right now" result instead of letting a raw driver error
// escape as an unhandled crash. Under real multi-process contention
// (verified via budget_worktree.test.ts) this is a reachable, expected
// outcome, not a bug on its own — only leaving it unhandled was the bug.
export class SqliteRetryExhaustedError extends Error {
  constructor(label: string, attempts: number, cause: unknown) {
    super(`${label}: still busy after ${attempts} attempts`);
    this.name = "SqliteRetryExhaustedError";
    this.cause = cause;
  }
}

export function withSqliteRetry<T>(fn: () => T, label: string, maxAttempts = 5): T {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return fn();
    } catch (err: any) {
      const busy = /SQLITE_BUSY|database is locked/i.test(String(err?.message ?? ""));
      if (!busy) throw err;
      if (attempt === maxAttempts) throw new SqliteRetryExhaustedError(label, maxAttempts, err);
      const waitMs = 50 * 2 ** (attempt - 1);
      console.log(`  [${label}] SQLITE_BUSY — retrying in ${waitMs}ms (attempt ${attempt}/${maxAttempts})`);
      sleepSync(waitMs);
    }
  }
  // Unreachable — loop above always returns or throws.
  throw new Error(`${label}: retry loop exited without returning`);
}