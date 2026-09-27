// src/llm/budget_legacy_migration.test.ts
//
// ensureBudgetTable() has a one-time migration branch: if a
// `budget_state` row exists at the pre-repo_id schema's `id = 1` (from
// before the per-repo migration), it's copied forward into a repo_id-
// keyed row before the normal INSERT OR IGNORE runs. No existing test
// ever seeds that legacy row first, so the migration's try body (the
// SELECT ... WHERE id = 1, the INSERT, and the console.log) was never
// covered — only the empty `catch {}` was reachable, via a normal
// first-run repo with no legacy table shape at all.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getDbCompat } from "../manifest/store";
import { safeRmSync } from "../platform/fs_retry.js";
import { getBudgetSnapshot } from "./budget";

let originalCwd: string;
let tmpDir: string;
let log: typeof console.log;
let logLines: string[];

beforeEach(() => {
  originalCwd = process.cwd();
  tmpDir = mkdtempSync(join(tmpdir(), "purix-budget-legacy-test-"));
  process.chdir(tmpDir);
  log = console.log;
  logLines = [];
  console.log = (...args: unknown[]) => {
    logLines.push(args.join(" "));
  };
});

afterEach(() => {
  console.log = log;
  closeDb();
  process.chdir(originalCwd);
  safeRmSync(tmpDir);
});

describe("ensureBudgetTable — legacy row migration", () => {
  it("migrates a pre-existing id=1 legacy row into the current repo's repo_id row", () => {
    // Seed the table in the OLD shape (id = 1, no repo_id row yet) before
    // any budget.ts function has a chance to create it in the new shape.
    const db = getDbCompat();
    db.run(`
      CREATE TABLE IF NOT EXISTS budget_state (
        id INTEGER PRIMARY KEY,
        repo_id TEXT,
        total_spent_usd REAL NOT NULL DEFAULT 0,
        calls INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      )
    `);
    db.run(
      `INSERT INTO budget_state (id, total_spent_usd, calls, updated_at) VALUES (1, ?, ?, ?)`,
      [3.25, 14, "2026-01-01T00:00:00.000Z"]
    );

    // First real read triggers ensureBudgetTable(), which should find the
    // legacy row and copy it forward instead of starting fresh at zero.
    // getBudgetSnapshot() only exposes totalSpentUsd/ceiling — `calls` is
    // internal to the row, so the migration having preserved it is
    // checked directly against the row further down via the raw db.
    const snapshot = getBudgetSnapshot();

    expect(snapshot?.totalSpentUsd).toBe(3.25);
    expect(logLines.some((l) => l.includes("Migrated legacy global budget state"))).toBe(true);

    const migratedRow = db.query(`SELECT calls FROM budget_state WHERE repo_id IS NOT NULL`).get() as { calls: number };
    expect(migratedRow.calls).toBe(14);
  });

  it("starts fresh at zero, without logging a migration, when no legacy id=1 row exists", () => {
    const snapshot = getBudgetSnapshot();
    expect(snapshot?.totalSpentUsd).toBe(0);
    expect(logLines.some((l) => l.includes("Migrated legacy"))).toBe(false);
  });

  it("does not throw and falls through to a normal fresh row if the legacy-shape query itself fails", () => {
    // Create the table in the NEW shape only (no `id` column at all) so
    // the legacy SELECT ... WHERE id = 1 throws (no such column) and the
    // empty catch{} swallows it, same as any other pre-repo_id schema
    // mismatch.
    const db = getDbCompat();
    db.run(`
      CREATE TABLE IF NOT EXISTS budget_state (
        repo_id TEXT PRIMARY KEY,
        total_spent_usd REAL NOT NULL DEFAULT 0,
        calls INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      )
    `);

    const snapshot = getBudgetSnapshot();
    expect(snapshot?.totalSpentUsd).toBe(0);
  });
});
