// src/security/override_audit.ts
import { getDbCompat as getDb } from "../manifest/store.js";

export interface OverrideAuditEntry {
  id: string;
  actor: string;
  gate_name: string;
  reason: string;
  finding: string;
  timestamp: string;
}

function ensureTable(): void {
  const db = getDb();
  db.run(`
    CREATE TABLE IF NOT EXISTS override_audits (
      id TEXT PRIMARY KEY,
      actor TEXT NOT NULL,
      gate_name TEXT NOT NULL,
      reason TEXT NOT NULL,
      finding TEXT NOT NULL,
      timestamp TEXT NOT NULL
    )
  `);
}

export function recordOverrideAudit(gateName: string, reason: string, finding: string, actor = "operator"): OverrideAuditEntry {
  if (!reason || reason.trim() === "") {
    throw new Error("Override rejected: reason cannot be empty or whitespace-only.");
  }
  ensureTable();
  const db = getDb();
  const id = `ovr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const timestamp = new Date().toISOString();
  db.run(
    `INSERT INTO override_audits (id, actor, gate_name, reason, finding, timestamp) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, actor, gateName, reason.trim(), finding, timestamp]
  );
  return { id, actor, gate_name: gateName, reason: reason.trim(), finding, timestamp };
}

export function getOverrideAudits(): OverrideAuditEntry[] {
  ensureTable();
  const db = getDb();
  return db.query(`SELECT id, actor, gate_name, reason, finding, timestamp FROM override_audits ORDER BY timestamp ASC`).all() as OverrideAuditEntry[];
}
