// src/security/audit_tamper_evidence.ts
import { getDb as getRawDb, getDbCompat as getDb } from "../manifest/store.js";
import { createHash, createHmac } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { withImmediateTx } from "../platform/sqlite_tx.js";
import { writeJsonAtomic } from "../platform/atomic_write.js";
import { resolveSharedStateDir } from "../state/git_common_dir.js";

export interface TamperEvidenceRecord {
  id: string;
  payload: string;
  timestamp: string;
  prev_hash: string;
  hash: string;
}

const GENESIS = "0000000000000000000000000000000000000000000000000000000000000000";
const preparedDbs = new WeakSet<DatabaseSync>();

function ensureTable(): void {
  const db = getDb();
  const raw = getRawDb();
  if (preparedDbs.has(raw)) return;
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
  // A2a-1: two records can never share one predecessor. Appends are serialised by a transaction (below); this index is the
  // second line, so a writer that bypasses the transaction (an old Purix version, a hand-written INSERT) fails loudly instead of
  // forking the chain. A chain that ALREADY forked cannot get the index; it stays reported as broken by verify, and new appends
  // are still serialised by the transaction.
  try {
    db.run(`CREATE UNIQUE INDEX IF NOT EXISTS audit_chain_prev_hash_uniq ON audit_chain(prev_hash)`);
  } catch {
    // an existing fork: leave it for verifyAuditChain to report
  }
  preparedDbs.add(raw);
}

/**
 * Runs `fn` as one write step. Opens BEGIN IMMEDIATE (the write lock is taken before the last record is read), or joins the
 * transaction the caller already holds. Returns whether it joined.
 */
export function inWriteTransaction<T>(raw: DatabaseSync, fn: () => T): { value: T; joined: boolean } {
  if ((raw as { isTransaction?: boolean }).isTransaction === true) return { value: fn(), joined: true };
  try {
    return { value: withImmediateTx(raw, fn), joined: false };
  } catch (err) {
    // Older Node has no isTransaction. BEGIN is refused (before anything is touched) when the caller holds a transaction: join it.
    if (err instanceof Error && /within a transaction/i.test(err.message)) return { value: fn(), joined: true };
    throw err;
  }
}

function appendInTransaction(payloadStr: string): TamperEvidenceRecord {
  const db = getDb();
  const timestamp = new Date().toISOString();
  const lastRow = db.query(`SELECT hash FROM audit_chain ORDER BY id DESC LIMIT 1`).get() as { hash: string } | null;
  // After a prune that removed every record, the next record continues from the checkpoint, not from genesis.
  const cp = lastRow ? null : (db.query(`SELECT checkpoint_hash FROM audit_checkpoints ORDER BY id DESC LIMIT 1`).get() as { checkpoint_hash: string } | null);
  const prevHash = lastRow?.hash ?? cp?.checkpoint_hash ?? GENESIS;
  const hash = createHash("sha256").update(`${prevHash}|${timestamp}|${payloadStr}`).digest("hex");
  db.run(`INSERT INTO audit_chain (payload, timestamp, prev_hash, hash) VALUES (?, ?, ?, ?)`, [payloadStr, timestamp, prevHash, hash]);
  return { id: "latest", payload: payloadStr, timestamp, prev_hash: prevHash, hash };
}

/**
 * Appends one record. Read-last-hash and insert are one transaction, so concurrent writers (other processes, the MCP server and a
 * CLI command) queue instead of both extending the same record (research 08: 4 writers x 200 appends forked the chain in 5 of 5
 * runs and verify then called it tampering). After the commit the head is written to the receipt file (see below).
 */
export function appendAuditRecord(payload: object): TamperEvidenceRecord {
  ensureTable();
  const raw = getRawDb();
  const payloadStr = JSON.stringify(payload);
  const { value, joined } = inWriteTransaction(raw, () => appendInTransaction(payloadStr));
  // Inside a caller's transaction the record is not durable yet, and a receipt for a record that is then rolled back would read
  // as a cut tail. The next top-level append writes the receipt for everything before it.
  if (!joined) writeAuditReceiptFromDb();
  return value;
}

// ---------------------------------------------------------------------------------------------------------------------
// Head receipt (A2a-1)
//
// A chain with its newest records deleted is still internally valid. The receipt is the newest head, written to a file beside
// the store after each append. Verification asks: does the chain still contain the head the receipt remembers? A receipt BEHIND
// the chain is normal (another writer appended after this one wrote). A receipt AHEAD of the chain means records were removed.
//
// Honest limit: someone who can edit the store AND this file can remove records and the receipt together. The git trailer
// (evidence/anchor.ts, Purix-Evidence in the commit message) is the second anchor, and once pushed it is outside the machine.

export interface AuditReceipt {
  schema: 1;
  head: string;
  /** Row id of the head when the receipt was written; a receipt is only ever replaced by a higher one. */
  id: number;
  recordedAt: string;
}
export type AuditReceiptState = "matches" | "behind" | "ahead_of_chain";
export type AuditReceiptReading = { kind: "absent" } | { kind: "unreadable" } | { kind: "ok"; receipt: AuditReceipt };

export function auditReceiptPath(baseDir: string = process.cwd()): string {
  return join(resolveSharedStateDir(baseDir), "audit-head.json");
}

/** The words for a receipt that is ahead of the chain. One place, so `purix check`, the scheduler and the evidence views say the same thing. */
export function receiptAheadReason(receipt: AuditReceipt): string {
  return `the chain does not contain the head its receipt recorded (${receipt.head.slice(0, 12)}…, record ${receipt.id}). Records were removed from the end of the chain, or this store is not the one the receipt belongs to.`;
}

export function loadAuditReceipt(baseDir: string = process.cwd()): AuditReceiptReading {
  const path = auditReceiptPath(baseDir);
  if (!existsSync(path)) return { kind: "absent" };
  try {
    const v = JSON.parse(readFileSync(path, "utf-8")) as Partial<AuditReceipt>;
    if (v && v.schema === 1 && typeof v.head === "string" && /^[0-9a-f]{64}$/.test(v.head) && typeof v.id === "number" && typeof v.recordedAt === "string") {
      return { kind: "ok", receipt: v as AuditReceipt };
    }
  } catch {
    // fall through
  }
  return { kind: "unreadable" };
}

export function readAuditReceipt(): AuditReceipt | null {
  const r = loadAuditReceipt();
  return r.kind === "ok" ? r.receipt : null;
}

/** Writes the receipt for the newest record in the store, unless the receipt already covers a newer one. Never throws: the record is already safe. */
export function writeAuditReceiptFromDb(): void {
  try {
    const row = getDb().query(`SELECT id, hash FROM audit_chain ORDER BY id DESC LIMIT 1`).get() as { id: number; hash: string } | null;
    if (!row) return;
    const current = loadAuditReceipt();
    if (current.kind === "ok" && current.receipt.id >= row.id) return;
    const receipt: AuditReceipt = { schema: 1, head: row.hash, id: row.id, recordedAt: new Date().toISOString() };
    writeJsonAtomic(auditReceiptPath(), receipt);
  } catch {
    // The chain record is committed. A missing receipt only means the next append writes it.
  }
}

/** Forget the receipt. For a person who has looked at a reported cut and knows why (for example a store restored from a backup). */
export function resetAuditReceipt(): boolean {
  const path = auditReceiptPath();
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

/** Pure: how the receipt relates to the stored rows. */
export function verifyAuditReceipt(rows: AuditRow[], checkpoint: AuditCheckpointRow | null, receipt: AuditReceipt): { state: AuditReceiptState } {
  const at = rows.findIndex((r) => r.hash === receipt.head);
  if (at >= 0) return { state: at === rows.length - 1 ? "matches" : "behind" };
  // After a prune the head may be the checkpoint (the hash of the last removed record).
  if (checkpoint && checkpoint.checkpoint_hash === receipt.head) return { state: rows.length === 0 ? "matches" : "behind" };
  return { state: "ahead_of_chain" };
}

export type AuditReceiptReport = AuditVerification & { receipt: AuditReceiptState | "absent" | "unreadable" | "not_checked" };

/** The chain rule plus the receipt. `valid` is false for a broken chain and for a chain that no longer reaches the receipt's head. */
export function verifyAuditChainWithReceipt(): AuditReceiptReport {
  const { rows, checkpoint } = readAuditChain();
  const base = verifyAuditRows(rows, checkpoint);
  if (!base.valid) return { ...base, receipt: "not_checked" };
  const reading = loadAuditReceipt();
  if (reading.kind === "absent") return { ...base, receipt: "absent" };
  if (reading.kind === "unreadable") return { ...base, receipt: "unreadable", reason: `the head receipt (${auditReceiptPath()}) cannot be read, so the end of the chain is not vouched for` };
  const r = verifyAuditReceipt(rows, checkpoint, reading.receipt);
  if (r.state === "ahead_of_chain") {
    return {
      valid: false,
      recordCount: rows.length,
      receipt: "ahead_of_chain",
      reason: receiptAheadReason(reading.receipt),
    };
  }
  return { ...base, receipt: r.state };
}

export interface AuditRow { id: number; payload: string; timestamp: string; prev_hash: string; hash: string }
export interface AuditCheckpointRow { last_pruned_id: number; checkpoint_hash: string }
export type AuditVerification = { valid: boolean; compromisedIndex?: number; reason?: string; recordCount?: number };

/**
 * The chain rule, as a pure function of the stored rows. Shared by verifyAuditChain (live database) and by
 * `purix check` (a read-only snapshot), so the two can never disagree about what "tampered" means.
 */
export function verifyAuditRows(rows: AuditRow[], checkpoint: AuditCheckpointRow | null): AuditVerification {
  let expectedPrevHash = GENESIS;
  if (checkpoint && rows.length > 0) {
    const firstRow = rows[0]!;
    if (firstRow.id > checkpoint.last_pruned_id + 1 && firstRow.prev_hash !== checkpoint.checkpoint_hash) {
      return { valid: false, reason: `Checkpoint hash mismatch at pruned boundary` };
    }
    // The checkpoint explains a chain that starts after it. A chain that still holds rows at or before the checkpoint starts at genesis.
    if (firstRow.id > checkpoint.last_pruned_id && checkpoint.checkpoint_hash) expectedPrevHash = checkpoint.checkpoint_hash;
  }

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    // The first record is checked too: a chain that does not begin at genesis, and has no checkpoint to explain why,
    // has had its earliest records removed. (Before this check, cutting records off the front went unnoticed.)
    // Legacy: before the fix above, a record appended after a full prune started again from genesis. Accept that one shape,
    // and only for the first record after a checkpoint.
    const legacyRestart = i === 0 && !!checkpoint && row.id > checkpoint.last_pruned_id && row.prev_hash === GENESIS;
    if (row.prev_hash !== expectedPrevHash && !legacyRestart) {
      return {
        valid: false,
        compromisedIndex: i,
        reason: i === 0 ? `Chain does not start at its beginning and no checkpoint explains it (records removed before id ${row.id})` : `Broken prev_hash at record id ${row.id}`,
      };
    }
    const hashInput = `${row.prev_hash}|${row.timestamp}|${row.payload}`;
    const calculatedHash = createHash("sha256").update(hashInput).digest("hex");
    if (calculatedHash !== row.hash) {
      return { valid: false, compromisedIndex: i, reason: `Hash mismatch at record id ${row.id} (tamper detected)` };
    }
    expectedPrevHash = row.hash;
  }
  // recordCount lets callers tell "verified N records" from a vacuous pass on an empty chain.
  return { valid: true, recordCount: rows.length };
}

/** The stored chain and its latest checkpoint, exactly as read. Used by verifyAuditChain and by anchor checking. */
export function readAuditChain(): { rows: AuditRow[]; checkpoint: AuditCheckpointRow | null } {
  ensureTable();
  const db = getDb();
  const rows = db.query(`SELECT id, payload, timestamp, prev_hash, hash FROM audit_chain ORDER BY id ASC`).all() as AuditRow[];
  const checkpoint = db.query(`SELECT last_pruned_id, checkpoint_hash FROM audit_checkpoints ORDER BY id DESC LIMIT 1`).get() as AuditCheckpointRow | null;
  return { rows, checkpoint };
}

/** Internal consistency only. It cannot see records removed from the end; see evidence/anchor.ts for that. */
export function verifyAuditChain(): AuditVerification {
  const { rows, checkpoint } = readAuditChain();
  return verifyAuditRows(rows, checkpoint);
}

export function pruneAuditChain(olderThanMs: number): void {
  ensureTable();
  const db = getDb();
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  // Only a LEADING run of records that are all older than the cutoff is removed. The chain is ordered by id, but timestamps need not
  // rise with the id: a clock that was ahead or behind for a while leaves records whose stamps are out of order. Selecting every
  // record with an old stamp and then deleting everything up to the last of them would delete records the retention rule does
  // not select (a record stamped in the future, or the records written before one stamped in the 1970s). Stopping at the first
  // record that is not older keeps them; the chain stays valid because the checkpoint is the last record actually removed.
  const ordered = db.query(`SELECT id, hash, timestamp FROM audit_chain ORDER BY id ASC`).all() as { id: number; hash: string; timestamp: string }[];
  const targetRows: { id: number; hash: string }[] = [];
  for (const row of ordered) {
    if (!(row.timestamp < cutoff)) break;
    targetRows.push(row);
  }
  if (targetRows.length === 0) return;

  const lastPruned = targetRows[targetRows.length - 1]!;
  db.run(`INSERT INTO audit_checkpoints (last_pruned_id, checkpoint_hash, checkpoint_at) VALUES (?, ?, ?)`, [
    lastPruned.id,
    lastPruned.hash,
    new Date().toISOString(),
  ]);
  db.run(`DELETE FROM audit_chain WHERE id <= ?`, [lastPruned.id]);
}

// BUG FIX: this used to default `secret` to the hardcoded literal
// "audit-export-secret" — every export from every install would produce
// an HMAC signature computable by anyone who read this source file,
// which is a signature that provides zero actual tamper-evidence
// guarantee (indistinguishable from having no signature at all, except
// that it looks like one). There are still zero production callers of
// this function today, so there's no live caller to break — but a
// security-relevant default like this must fail closed the moment it's
// wired up, not silently work with a public secret until someone
// notices. Callers now MUST supply a real, install-specific secret.
export function exportAuditChainJson(secret: string): string {
  if (!secret || secret.trim() === "") {
    throw new Error(
      "exportAuditChainJson() requires a real, install-specific secret — refusing to sign with an empty or default value."
    );
  }
  ensureTable();
  const db = getDb();
  const rows = db.query(`SELECT id, payload, timestamp, prev_hash, hash FROM audit_chain ORDER BY id ASC`).all();
  const data = JSON.stringify({ exported_at: new Date().toISOString(), records: rows });
  const signature = createHmac("sha256", secret).update(data).digest("hex");
  return JSON.stringify({ data: JSON.parse(data), signature }, null, 2);
}