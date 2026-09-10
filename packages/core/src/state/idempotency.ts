// src/state/idempotency.ts
import { createHash } from "node:crypto";
import { getDbCompat as getDb } from "../manifest/store.js";

function ensureTable(): void {
  const db = getDb();
  db.run(`
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      key TEXT PRIMARY KEY,
      component_id TEXT NOT NULL,
      resulting_version INTEGER NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
}

/**
 * Scoped to exactly what Node 1 treats as "the request": component, raw
 * instruction text, and the file state it started from. drift.ts already
 * computes that hash, so this doesn't cost a second pass over the files.
 * Two calls that hash the same are the same request; once a real commit
 * changes last_synced_hash, the next genuinely different request gets a
 * new key automatically — this never blocks a legitimate follow-up edit.
 */
export function computeRequestKey(componentId: string, rawInstruction: string, filesHash: string): string {
  const normalized = rawInstruction.trim().toLowerCase().replace(/\s+/g, " ");
  return createHash("sha256").update(`${componentId}|${normalized}|${filesHash}`).digest("hex");
}

export function findPriorCommit(key: string): { resultingVersion: number } | null {
  ensureTable();
  const db = getDb();
  const row = db.query(`SELECT resulting_version FROM idempotency_keys WHERE key = ?`).get(key) as any;
  return row ? { resultingVersion: row.resulting_version } : null;
}

export function recordRequestCommit(key: string, componentId: string, resultingVersion: number): void {
  ensureTable();
  const db = getDb();
  db.run(
    `INSERT INTO idempotency_keys (key, component_id, resulting_version, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET resulting_version = excluded.resulting_version`,
    [key, componentId, resultingVersion, new Date().toISOString()]
  );
}