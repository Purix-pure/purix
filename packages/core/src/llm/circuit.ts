// src/llm/circuit.ts
import { getDbCompat as getDb } from "../manifest/store.js";
import { withSqliteRetry } from "./sqlite_retry.js";

const FAILURE_THRESHOLD = 5;
const COOLDOWN_MS = 60_000;

// Security fix (review finding #3): same issue and same fix shape as
// budget.ts — circuit_breaker.json was a plain read-mutate-write JSON
// file with no protection against two concurrent `purix modify`
// invocations racing each other. State now lives as a single row in the
// shared manifest SQLite database, and recordCircuitFailure uses one
// atomic UPDATE (with the open_until decision made in the same statement,
// via CASE, against the pre-update failure count) rather than a
// read-then-write pair.
function ensureCircuitTable(): void {
  const db = getDb();
  db.run(`
    CREATE TABLE IF NOT EXISTS circuit_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      open_until TEXT
    )
  `);
  db.run(`INSERT OR IGNORE INTO circuit_state (id, consecutive_failures, open_until) VALUES (1, 0, NULL)`);
}

interface CircuitRow {
  consecutive_failures: number;
  open_until: string | null;
}

function readCircuitRow(): CircuitRow {
  ensureCircuitTable();
  const db = getDb();
  const row = db
    .query(`SELECT consecutive_failures, open_until FROM circuit_state WHERE id = 1`)
    .get() as CircuitRow | null;
  return row ?? { consecutive_failures: 0, open_until: null };
}

export function assertCircuitClosed(): void {
  const state = readCircuitRow();
  if (state.open_until && new Date(state.open_until).getTime() > Date.now()) {
    const secondsLeft = Math.ceil((new Date(state.open_until).getTime() - Date.now()) / 1000);
    throw new Error(
      `Circuit breaker open — ${state.consecutive_failures} consecutive LLM failures. ` +
        `Not retrying for ~${secondsLeft}s more. The provider looks down.`
    );
  }
}

export function recordCircuitSuccess(): void {
  withSqliteRetry(() => {
    ensureCircuitTable();
    getDb().run(`UPDATE circuit_state SET consecutive_failures = 0, open_until = NULL WHERE id = 1`);
  }, "circuit");
}

export function recordCircuitFailure(): void {
  const openedAt = new Date(Date.now() + COOLDOWN_MS).toISOString();
  const newCount = withSqliteRetry(() => {
    ensureCircuitTable();
    const db = getDb();
    // Atomic in one statement: the CASE's "consecutive_failures + 1" and
    // the plain "consecutive_failures + 1" in the SET both read the
    // pre-update row value, so this can't land on a stale count the way
    // a separate read-then-write pair could under concurrent failures.
    db.run(
      `UPDATE circuit_state
       SET consecutive_failures = consecutive_failures + 1,
           open_until = CASE WHEN consecutive_failures + 1 >= ? THEN ? ELSE open_until END
       WHERE id = 1`,
      [FAILURE_THRESHOLD, openedAt]
    );
    const row = db.query(`SELECT consecutive_failures FROM circuit_state WHERE id = 1`).get() as
      | { consecutive_failures: number }
      | null;
    return row?.consecutive_failures ?? 0;
  }, "circuit");

  if (newCount >= FAILURE_THRESHOLD) {
    console.log(`  [circuit] ${newCount} consecutive failures — opening for ${COOLDOWN_MS / 1000}s`);
  }
}