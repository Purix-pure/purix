// src/manifest/migrations.ts
import { getDbCompat as getDb } from "./store.js";
import type { FileSnapshot } from "./store.js";

export type MigrationStatus = "staged" | "active" | "rolled_back";

function ensureTable(): void {
  const db = getDb();
  db.run(`
    CREATE TABLE IF NOT EXISTS migrations (
      id TEXT PRIMARY KEY,
      component_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      version_from INTEGER NOT NULL,
      version_to INTEGER NOT NULL,
      before_snapshot TEXT NOT NULL,
      after_snapshot TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      activated_at TEXT,
      rolled_back_at TEXT
    )
  `);
}

export interface MigrationRecord {
  id: string;
  component_id: string;
  operation: string;
  version_from: number;
  version_to: number;
  before_snapshot: FileSnapshot[];
  after_snapshot: FileSnapshot[];
  status: MigrationStatus;
  created_at: string;
  activated_at: string | null;
  rolled_back_at: string | null;
}

function rowToRecord(r: any): MigrationRecord {
  return {
    ...r,
    before_snapshot: JSON.parse(r.before_snapshot),
    after_snapshot: JSON.parse(r.after_snapshot),
  };
}

/**
 * Section 14. Called for every contract-changing modify, regardless of
 * whether it's applied live or staged behind a flag — this is the
 * permanent rollback record that pending_operations does NOT provide
 * after completeModification deletes its journal row.
 */
export function recordMigration(entry: {
  component_id: string;
  operation: string;
  version_from: number;
  version_to: number;
  before_snapshot: FileSnapshot[];
  after_snapshot: FileSnapshot[];
  status: MigrationStatus;
}): string {
  ensureTable();
  const db = getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO migrations
     (id, component_id, operation, version_from, version_to, before_snapshot, after_snapshot, status, created_at, activated_at, rolled_back_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      entry.component_id,
      entry.operation,
      entry.version_from,
      entry.version_to,
      JSON.stringify(entry.before_snapshot),
      JSON.stringify(entry.after_snapshot),
      entry.status,
      now,
      entry.status === "active" ? now : null,
      null,
    ]
  );
  return id;
}

export function getMigration(id: string): MigrationRecord | null {
  ensureTable();
  const db = getDb();
  const row = db.query(`SELECT * FROM migrations WHERE id = ?`).get(id) as any;
  return row ? rowToRecord(row) : null;
}

export function setMigrationStatus(id: string, status: MigrationStatus): void {
  ensureTable();
  const db = getDb();
  const col = status === "active" ? "activated_at" : status === "rolled_back" ? "rolled_back_at" : null;
  if (col) {
    db.run(`UPDATE migrations SET status = ?, ${col} = ? WHERE id = ?`, [status, new Date().toISOString(), id]);
  } else {
    db.run(`UPDATE migrations SET status = ? WHERE id = ?`, [status, id]);
  }
}

export function listMigrations(componentId?: string): MigrationRecord[] {
  ensureTable();
  const db = getDb();
  const rows = componentId
    ? (db.query(`SELECT * FROM migrations WHERE component_id = ? ORDER BY created_at DESC`).all(componentId) as any[])
    : (db.query(`SELECT * FROM migrations ORDER BY created_at DESC`).all() as any[]);
  return rows.map(rowToRecord);
}