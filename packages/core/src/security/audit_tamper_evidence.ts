// src/security/audit_tamper_evidence.ts
import { getDbCompat as getDb } from "../manifest/store.js";
import { createHash, createHmac } from "node:crypto";

export interface TamperEvidenceRecord {
  id: string;
  payload: string;
  timestamp: string;
  prev_hash: string;
  hash: string;
}

function ensureTable(): void {
  const db = getDb();
  db.run(`
    CREATE TABLE IF NOT EXISTS audit_chain (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payload TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      prev_hash TEXT NOT NULL,
      hash TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS audit_checkpoints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      last_pruned_id INTEGER NOT NULL,
      checkpoint_hash TEXT NOT NULL,
      checkpoint_at TEXT NOT NULL
    )
  `);
}

export function appendAuditRecord(payload: object): TamperEvidenceRecord {
  ensureTable();
  const db = getDb();
  const timestamp = new Date().toISOString();
  const payloadStr = JSON.stringify(payload);

  const lastRow = db.query(`SELECT hash FROM audit_chain ORDER BY id DESC LIMIT 1`).get() as { hash: string } | null;
  const prevHash = lastRow?.hash ?? "0000000000000000000000000000000000000000000000000000000000000000";

  const hashInput = `${prevHash}|${timestamp}|${payloadStr}`;
  const hash = createHash("sha256").update(hashInput).digest("hex");

  db.run(
    `INSERT INTO audit_chain (payload, timestamp, prev_hash, hash) VALUES (?, ?, ?, ?)`,
    [payloadStr, timestamp, prevHash, hash]
  );

  return { id: "latest", payload: payloadStr, timestamp, prev_hash: prevHash, hash };
}

export function verifyAuditChain(): { valid: boolean; compromisedIndex?: number; reason?: string } {
  ensureTable();
  const db = getDb();
  const rows = db.query(`SELECT id, payload, timestamp, prev_hash, hash FROM audit_chain ORDER BY id ASC`).all() as any[];

  let expectedPrevHash = "0000000000000000000000000000000000000000000000000000000000000000";
  const checkpoint = db.query(`SELECT last_pruned_id, checkpoint_hash FROM audit_checkpoints ORDER BY id DESC LIMIT 1`).get() as { last_pruned_id: number; checkpoint_hash: string } | null;
  if (checkpoint && rows.length > 0) {
    const firstRow = rows[0]!;
    if (firstRow.id > checkpoint.last_pruned_id + 1 && firstRow.prev_hash !== checkpoint.checkpoint_hash) {
      return { valid: false, reason: `Checkpoint hash mismatch at pruned boundary` };
    }
  }

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (i === 0 && checkpoint && checkpoint.checkpoint_hash) {
      // First row after checkpoint
      expectedPrevHash = checkpoint.checkpoint_hash;
    }
    if (row.prev_hash !== expectedPrevHash && i > 0) {
      return { valid: false, compromisedIndex: i, reason: `Broken prev_hash at record id ${row.id}` };
    }
    const hashInput = `${row.prev_hash}|${row.timestamp}|${row.payload}`;
    const calculatedHash = createHash("sha256").update(hashInput).digest("hex");
    if (calculatedHash !== row.hash) {
      return { valid: false, compromisedIndex: i, reason: `Hash mismatch at record id ${row.id} (tamper detected)` };
    }
    expectedPrevHash = row.hash;
  }
  return { valid: true };
}

export function pruneAuditChain(olderThanMs: number): void {
  ensureTable();
  const db = getDb();
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const targetRows = db.query(`SELECT id, hash FROM audit_chain WHERE timestamp < ? ORDER BY id ASC`).all() as { id: number; hash: string }[];
  if (targetRows.length === 0) return;

  const lastPruned = targetRows[targetRows.length - 1]!;
  db.run(`INSERT INTO audit_checkpoints (last_pruned_id, checkpoint_hash, checkpoint_at) VALUES (?, ?, ?)`, [
    lastPruned.id,
    lastPruned.hash,
    new Date().toISOString(),
  ]);
  db.run(`DELETE FROM audit_chain WHERE id <= ?`, [lastPruned.id]);
}

export function exportAuditChainJson(secret = "audit-export-secret"): string {
  ensureTable();
  const db = getDb();
  const rows = db.query(`SELECT id, payload, timestamp, prev_hash, hash FROM audit_chain ORDER BY id ASC`).all();
  const data = JSON.stringify({ exported_at: new Date().toISOString(), records: rows });
  const signature = createHmac("sha256", secret).update(data).digest("hex");
  return JSON.stringify({ data: JSON.parse(data), signature }, null, 2);
}
