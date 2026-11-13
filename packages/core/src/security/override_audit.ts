// src/security/override_audit.ts
import { randomUUID } from "node:crypto";
import { getDb as getRawDb, getDbCompat as getDb } from "../manifest/store.js";
import { appendAuditRecord, inWriteTransaction, readAuditChain, writeAuditReceiptFromDb } from "./audit_tamper_evidence.js";

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

/**
 * Records a person's override of a gate. The row and a chain record are written in ONE transaction: either both exist or neither
 * does. A2a-1: the chain record holds the same fields, so editing or deleting the override_audits row afterwards no longer goes
 * unseen (research 08: editing or deleting every override row left the chain verdict valid). See verifyOverrideAudits.
 */
export function recordOverrideAudit(gateName: string, reason: string, finding: string, actor = "operator"): OverrideAuditEntry {
  if (!reason || reason.trim() === "") {
    throw new Error("Override rejected: reason cannot be empty or whitespace-only.");
  }
  ensureTable();
  const db = getDb();
  // H3: unique by construction (a random UUID), not by the luck of five Math.random characters in one millisecond.
  const id = `ovr_${randomUUID()}`;
  const timestamp = new Date().toISOString();
  const entry: OverrideAuditEntry = { id, actor, gate_name: gateName, reason: reason.trim(), finding, timestamp };
  const { joined } = inWriteTransaction(getRawDb(), () => {
    db.run(`INSERT INTO override_audits (id, actor, gate_name, reason, finding, timestamp) VALUES (?, ?, ?, ?, ?, ?)`, [id, actor, gateName, entry.reason, finding, timestamp]);
    appendAuditRecord({ event: "override", override_id: id, actor, gate_name: gateName, reason: entry.reason, finding, at: timestamp });
  });
  if (!joined) writeAuditReceiptFromDb();
  return entry;
}

export function getOverrideAudits(): OverrideAuditEntry[] {
  ensureTable();
  const db = getDb();
  return db.query(`SELECT id, actor, gate_name, reason, finding, timestamp FROM override_audits ORDER BY timestamp ASC`).all() as OverrideAuditEntry[];
}

export interface OverrideVerification {
  ok: boolean;
  /** Override records the chain holds. */
  checked: number;
  problems: string[];
  /** Rows in override_audits with no chain record: written before the chain held overrides, or inserted by hand. Not a failure by itself. */
  unchained: number;
}

/** Every override the chain remembers must still be in override_audits, unchanged. */
export function verifyOverrideAudits(): OverrideVerification {
  const rows = new Map(getOverrideAudits().map((r) => [r.id, r]));
  const problems: string[] = [];
  const seen = new Set<string>();
  let checked = 0;
  for (const rec of readAuditChain().rows) {
    let p: Record<string, unknown>;
    try {
      p = JSON.parse(rec.payload) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (p.event !== "override" || typeof p.override_id !== "string") continue;
    checked++;
    seen.add(p.override_id);
    const row = rows.get(p.override_id);
    if (!row) {
      problems.push(`override ${p.override_id} is in the audit chain but missing from the override table (a row was deleted)`);
      continue;
    }
    const same = row.actor === p.actor && row.gate_name === p.gate_name && row.reason === p.reason && row.finding === p.finding && row.timestamp === p.at;
    if (!same) problems.push(`override ${p.override_id} differs from what the audit chain recorded (a row was edited)`);
  }
  let unchained = 0;
  for (const id of rows.keys()) if (!seen.has(id)) unchained++;
  return { ok: problems.length === 0, checked, problems, unchained };
}
