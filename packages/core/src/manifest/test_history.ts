// src/manifest/test_history.ts
import { getDbCompat as getDb } from "./store.js";

function ensureTable(): void {
  const db = getDb();
  db.run(`
    CREATE TABLE IF NOT EXISTS test_history (
      component_id TEXT NOT NULL,
      test_name TEXT NOT NULL,
      results TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (component_id, test_name)
    )
  `);
}

const HISTORY_WINDOW = 5;
export const FLAKY_MIN_SAMPLES = 3; // need this many runs before quarantine can kick in at all

export function recordTestResult(componentId: string, testName: string, result: "pass" | "fail"): void {
  ensureTable();
  const db = getDb();
  const row = db
    .query(`SELECT results FROM test_history WHERE component_id = ? AND test_name = ?`)
    .get(componentId, testName) as any;
  const history: ("pass" | "fail")[] = row ? JSON.parse(row.results) : [];
  history.push(result);
  while (history.length > HISTORY_WINDOW) history.shift();
  db.run(
    `INSERT INTO test_history (component_id, test_name, results, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(component_id, test_name) DO UPDATE SET results = excluded.results, updated_at = excluded.updated_at`,
    [componentId, testName, JSON.stringify(history), new Date().toISOString()]
  );
}

/**
 * How many historical samples this test has recorded so far — the same
 * count isFlaky checks against FLAKY_MIN_SAMPLES internally, exposed so
 * a caller can tell in advance whether isFlaky could possibly have
 * returned true for this test yet (it can't, below FLAKY_MIN_SAMPLES),
 * without duplicating that threshold logic at the call site.
 */
export function sampleCount(componentId: string, testName: string): number {
  ensureTable();
  const db = getDb();
  const row = db
    .query(`SELECT results FROM test_history WHERE component_id = ? AND test_name = ?`)
    .get(componentId, testName) as any;
  if (!row) return 0;
  const history: ("pass" | "fail")[] = JSON.parse(row.results);
  return history.length;
}

/**
 * Flaky = mixed pass/fail in its own recent history. A test that has
 * ONLY ever failed is not flaky — it's just broken, and should still
 * block. Section 10's actual intent: don't chase non-deterministic
 * regressions, don't excuse deterministic ones.
 */
export function isFlaky(componentId: string, testName: string): boolean {
  ensureTable();
  const db = getDb();
  const row = db
    .query(`SELECT results FROM test_history WHERE component_id = ? AND test_name = ?`)
    .get(componentId, testName) as any;
  if (!row) return false;
  const history: ("pass" | "fail")[] = JSON.parse(row.results);
  if (history.length < FLAKY_MIN_SAMPLES) return false;
  return history.includes("pass") && history.includes("fail");
}