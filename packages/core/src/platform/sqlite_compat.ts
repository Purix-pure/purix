// src/platform/sqlite_compat.ts
//
// Runtime migration (ADR-009, ADR-016): manifest/store.ts's own internal
// functions were migrated to call node:sqlite's DatabaseSync directly
// (prepare/run/get/all — see store.ts's header comment). But getDb() is
// also imported directly by seven other files in this package —
// llm/budget.ts, llm/circuit.ts, manifest/events.ts, manifest/library.ts,
// manifest/migrations.ts, manifest/test_history.ts, state/idempotency.ts
// — each calling bun:sqlite's `.query(sql).get()/.all()` and
// `.run(sql, [params])` shape directly against the shared handle.
// Several of those (circuit.ts's CASE-based atomic increment, budget.ts's
// burn-guard ceiling enforcement) are safety-load-bearing SQL that's
// exactly the kind of logic a hand-transcription error could silently
// break without it showing up until a real concurrent-write race. Rather
// than hand-migrate seven files' SQL by eye, this wrapper preserves the
// exact bun:sqlite call shape those files already use, unchanged, on top
// of node:sqlite underneath — the only change needed at each of those
// seven call sites is the import line (getDb -> getDbCompat, see
// manifest/store.ts), not any of their actual SQL or business logic.
//
// This is the same pattern as packages/api/src/db/client.ts's CompatDb,
// duplicated rather than shared because packages/core cannot import
// from packages/api (see architecture.md §2's package boundary) and
// there's no shared low-level package between them for a ~30-line
// adapter to live in.
import type { DatabaseSync, StatementSync } from "node:sqlite";

class CompatStatement {
  constructor(private readonly stmt: StatementSync) {}
  get(...args: unknown[]): unknown {
    return this.stmt.get(...(args as any[]));
  }
  all(...args: unknown[]): unknown[] {
    return this.stmt.all(...(args as any[])) as unknown[];
  }
}

export class CompatDb {
  constructor(private readonly raw: DatabaseSync) {}

  query(sql: string): CompatStatement {
    return new CompatStatement(this.raw.prepare(sql));
  }

  run(sql: string, params: unknown[] = []): { changes: number | bigint; lastInsertRowid: number | bigint } {
    return this.raw.prepare(sql).run(...(params as any[]));
  }
}
