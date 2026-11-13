// packages/core/src/platform/sqlite_tx.ts
//
// A1 shared rail: one transaction helper for every writer that needs "read, decide, write" to be one step.
//
// node:sqlite has no `.transaction()`. manifest/store.ts, manifest/library.ts and language/registry_cache.ts each write their own
// `BEGIN IMMEDIATE ... COMMIT / ROLLBACK` by hand (store.ts's is a private function, so it cannot be imported). This module is
// the same thing in one place, so the phases that need it (A2a: audit-chain append; A2b: reconcile; A5: store) import one
// helper and do not write a ninth copy. The three existing hand-written copies are NOT touched here: they live in files other
// phases own, and the swap is a follow-up for those owners. Until then the same rule is written four times.
//
// Why IMMEDIATE and not the default deferred BEGIN: IMMEDIATE takes the write lock when the transaction starts. With a deferred
// BEGIN two writers can both READ the same last row, then one fails to WRITE (SQLITE_BUSY) or, worse, both write on top of a
// stale read. The audit chain forking under concurrent writers (research 08, 5 of 5 runs) is that failure.
//
// Nesting: a call made inside another withImmediateTx on the same connection joins it through a SAVEPOINT, so an inner failure
// rolls back only the inner work and an inner success is kept or dropped with the outer transaction. SQLite itself refuses a
// second BEGIN, so without this a helper called from inside another helper would throw "cannot start a transaction within a
// transaction".
//
// What this does NOT do: it does not retry on SQLITE_BUSY (set `PRAGMA busy_timeout` on the connection; when the wait runs out
// the BEGIN throws and so does this), and it does not make `fn` async: node:sqlite is synchronous, and an `await` inside `fn`
// would let another caller interleave, so an async `fn` is rejected rather than silently losing atomicity.
import type { DatabaseSync } from "node:sqlite";

const depthByDb = new WeakMap<DatabaseSync, number>();

function isPromiseLike(v: unknown): v is PromiseLike<unknown> {
  return v !== null && (typeof v === "object" || typeof v === "function") && typeof (v as { then?: unknown }).then === "function";
}

export function withImmediateTx<T>(db: DatabaseSync, fn: () => T): T {
  const depth = depthByDb.get(db) ?? 0;
  const savepoint = depth > 0 ? `purix_sp_${depth}` : null;
  db.exec(savepoint ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
  depthByDb.set(db, depth + 1);
  try {
    const result = fn();
    if (isPromiseLike(result)) {
      // Cannot be made atomic: the callback would finish after the COMMIT below. Fail loudly and roll back.
      throw new Error("withImmediateTx: the callback returned a promise. node:sqlite is synchronous; run the awaited work before the transaction and pass only synchronous database work to fn.");
    }
    db.exec(savepoint ? `RELEASE ${savepoint}` : "COMMIT");
    return result;
  } catch (err) {
    try {
      db.exec(savepoint ? `ROLLBACK TO ${savepoint}` : "ROLLBACK");
      if (savepoint) db.exec(`RELEASE ${savepoint}`);
    } catch {
      // The transaction was never opened (BEGIN itself threw SQLITE_BUSY) or was already closed by the callback.
      // Surface the original error, not a secondary rollback failure.
    }
    throw err;
  } finally {
    if (depth === 0) depthByDb.delete(db);
    else depthByDb.set(db, depth);
  }
}
