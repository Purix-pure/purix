// src/manifest/library.ts
import { getDb, getDbCompat } from "./store.js";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ChangeEdit } from "../llm/classify.js";
import { createConfigStore } from "../state/config.js";
import { resolveLanguage } from "../language/registry.js";
import { inWriteTransaction } from "../security/audit_tamper_evidence.js";
import { LIBRARY_GENESIS_HASH, libraryRowHash, verifyLibraryRows, verifyOneLanguage, type LibraryChainRow } from "./library_chain.js";

function getConfig() {
  return createConfigStore(process.cwd());
}

function ensureTable(): void {
  const db = getDbCompat();
  db.run(`
    CREATE TABLE IF NOT EXISTS operation_library (
      id TEXT PRIMARY KEY,
      task_signature TEXT UNIQUE NOT NULL,
      component_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      description TEXT NOT NULL,
      edits TEXT NOT NULL,
      promoted_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL,
      usage_count INTEGER NOT NULL DEFAULT 0,
      prev_hash TEXT NOT NULL DEFAULT '',
      hash TEXT NOT NULL DEFAULT '',
      language TEXT NOT NULL DEFAULT 'typescript'
    )
  `);
  try {
    db.run(`ALTER TABLE operation_library ADD COLUMN language TEXT NOT NULL DEFAULT 'typescript'`);
  } catch { /* column already exists on a previously-migrated DB — ignore */ }
}

export function computeTaskSignature(componentId: string, operation: string, instruction: string): string {
  const normalized = instruction.trim().toLowerCase().replace(/\s+/g, " ");
  return createHash("sha256").update(`${componentId}|${operation}|${normalized}`).digest("hex");
}

export interface LibraryEntry {
  id: string;
  task_signature: string;
  component_id: string;
  operation: string;
  description: string;
  edits: ChangeEdit[];
  promoted_at: string;
  last_used_at: string;
  usage_count: number;
  prev_hash?: string;
  hash?: string;
  language?: string;
}

export function findLibraryMatch(taskSignature: string, language?: string): LibraryEntry | null {
  ensureTable();
  const db = getDbCompat();
  const lang = language ?? "typescript";
  const row = db.query(`SELECT * FROM operation_library WHERE task_signature = ? AND language = ?`).get(taskSignature, lang) as any;
  if (!row) return null;
  return { ...row, edits: JSON.parse(row.edits) } as LibraryEntry;
}

/**
 * F05-10: re-computes prev_hash and hash for every row of `language` at or after `fromRowid` (the whole language when omitted).
 * Called, inside the caller's write transaction, after the library itself changed or removed a row, so a change the library makes on
 * purpose never reads as damage. It never repairs damage: if a row it reaches no longer matches its OWN stored hash (its edits or
 * signature were changed behind the library's back), it stops there and leaves that row and everything after it as they are, so
 * verifyLibraryChain keeps reporting it. Rows before `fromRowid` are never touched.
 */
function resealChain(language: string, fromRowid?: number): void {
  const db = getDbCompat();
  let prev = LIBRARY_GENESIS_HASH;
  if (fromRowid !== undefined) {
    const before = db.query(`SELECT hash FROM operation_library WHERE language = ? AND rowid < ? ORDER BY rowid DESC LIMIT 1`).get(language, fromRowid) as { hash: string } | null | undefined;
    if (before) prev = before.hash;
  }
  const rows = db
    .query(`SELECT rowid AS rid, task_signature, edits, prev_hash, hash FROM operation_library WHERE language = ? AND rowid >= ? ORDER BY rowid ASC`)
    .all(language, fromRowid ?? 0) as { rid: number; task_signature: string; edits: string; prev_hash: string; hash: string }[];
  const update = getDb().prepare(`UPDATE operation_library SET prev_hash = ?, hash = ? WHERE rowid = ?`);
  for (const row of rows) {
    // A re-promoted row was just rewritten by promoteOperation and is the one row allowed not to match itself yet.
    if (row.rid !== fromRowid && libraryRowHash(row.prev_hash, row.task_signature, row.edits, language) !== row.hash) return;
    const hash = libraryRowHash(prev, row.task_signature, row.edits, language);
    update.run(prev, hash, row.rid);
    prev = hash;
  }
}

/** Re-seals each language from its lowest changed row. `changed` holds the rowid and language of every row just removed or rewritten. */
function resealChanged(changed: { rid: number; language: string }[]): void {
  const lowest = new Map<string, number>();
  for (const c of changed) lowest.set(c.language, Math.min(c.rid, lowest.get(c.language) ?? Number.POSITIVE_INFINITY));
  for (const [language, rid] of lowest) resealChain(language, rid);
}

export function enforceEviction(language: string = "typescript"): void {
  const db = getDbCompat();
  const countRow = db.query(`SELECT COUNT(*) as cnt FROM operation_library WHERE language = ?`).get(language) as { cnt: number };
  const maxEntries = getConfig().get("operationLibrary.maxEntries") as number ?? 50000;
  if (countRow.cnt >= maxEntries) {
    inWriteTransaction(getDb(), () => {
      const victims = db
        .query(`SELECT rowid AS rid, id FROM operation_library WHERE language = ? ORDER BY last_used_at ASC, rowid ASC LIMIT ?`)
        .all(language, countRow.cnt - maxEntries + 1) as { rid: number; id: string }[];
      for (const v of victims) db.run(`DELETE FROM operation_library WHERE id = ?`, [v.id]);
      // The first removed row is where the chain stops lining up; everything after it is linked again.
      resealChanged(victims.map((v) => ({ rid: v.rid, language })));
    });
  }
}

export function promoteOperation(entry: {
  component_id: string;
  operation: string;
  task_signature: string;
  description: string;
  edits: ChangeEdit[];
  language?: string;
}): void {
  ensureTable();
  const dbRaw = getDb();
  const db = getDbCompat();
  const now = new Date().toISOString();
  const lang = entry.language ?? resolveLanguage(entry.component_id);

  dbRaw.exec("BEGIN IMMEDIATE");
  try {
    enforceEviction(lang);
    const lastRow = db.query(`SELECT hash FROM operation_library WHERE language = ? ORDER BY rowid DESC LIMIT 1`).get(lang) as { hash: string } | null;
    const prevHash = lastRow?.hash ?? LIBRARY_GENESIS_HASH;
    const editsStr = JSON.stringify(entry.edits);
    const hash = libraryRowHash(prevHash, entry.task_signature, editsStr, lang);

    const existing = db.query(`SELECT rowid AS rid, language FROM operation_library WHERE task_signature = ?`).get(entry.task_signature) as { rid: number; language: string } | null | undefined;
    db.run(
      `INSERT INTO operation_library (id, task_signature, component_id, operation, description, edits, promoted_at, last_used_at, usage_count, prev_hash, hash, language)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
       ON CONFLICT(task_signature) DO UPDATE SET
         description = excluded.description, edits = excluded.edits, last_used_at = excluded.last_used_at, prev_hash = excluded.prev_hash, hash = excluded.hash, language = excluded.language`,
      [randomUUID(), entry.task_signature, entry.component_id, entry.operation, entry.description, editsStr, now, now, prevHash, hash, lang]
    );
    // F05-10: an existing entry keeps its place in the table but its edits changed, so the rows after it are linked again. (Before this,
    // the row was given the newest row's hash as its predecessor, which broke the chain at that row.) A language change re-links both.
    if (existing) resealChanged([{ rid: existing.rid, language: lang }, ...(existing.language !== lang ? [{ rid: existing.rid, language: existing.language }] : [])]);
    dbRaw.exec("COMMIT");
  } catch (err) {
    try {
      dbRaw.exec("ROLLBACK");
    } catch { /* already failing — rollback is best-effort, the original error still propagates */ }
    throw err;
  }
}

export function verifyLibraryChain(language?: string): { valid: boolean; compromisedIndex?: number; reason?: string } {
  ensureTable();
  const db = getDbCompat();
  const query = language
    ? `SELECT task_signature, edits, prev_hash, hash, language FROM operation_library WHERE language = ? ORDER BY rowid ASC`
    : `SELECT task_signature, edits, prev_hash, hash, language FROM operation_library ORDER BY rowid ASC`;
  const rows = (language ? db.query(query).all(language) : db.query(query).all()) as LibraryChainRow[];
  // F05-10: one chain per language. Checked as one chain across languages it could not hold for two languages at once.
  return language ? verifyOneLanguage(rows) : verifyLibraryRows(rows);
}

export function markLibraryUsed(taskSignature: string): void {
  ensureTable();
  const db = getDbCompat();
  db.run(
    `UPDATE operation_library SET usage_count = usage_count + 1, last_used_at = ? WHERE task_signature = ?`,
    [new Date().toISOString(), taskSignature]
  );
}

export function listLibrary(options: { verifyExistence?: boolean; language?: string } = {}): LibraryEntry[] {
  ensureTable();
  const db = getDbCompat();
  const query = options.language
    ? `SELECT * FROM operation_library WHERE language = ? ORDER BY usage_count DESC`
    : `SELECT * FROM operation_library ORDER BY usage_count DESC`;
  const rows = (options.language ? db.query(query).all(options.language) : db.query(query).all()) as any[];
  const entries = rows.map((r) => ({ ...r, edits: JSON.parse(r.edits) })) as LibraryEntry[];

  if (!options.verifyExistence) {
    return entries;
  }

  const gone: LibraryEntry[] = [];
  const kept = entries.filter((entry) => {
    const exists = fs.existsSync(path.resolve(process.cwd(), entry.component_id));
    if (!exists) gone.push(entry);
    return exists;
  });
  if (gone.length > 0) removeEntries(gone.map((e) => e.id));
  return kept;
}

export function clearLibrary(): void {
  ensureTable();
  const db = getDbCompat();
  db.run(`DELETE FROM operation_library`);
}

/** Deletes the rows with these ids and links the rows after each one again (F05-10), in one transaction. */
function removeEntries(ids: string[]): void {
  const db = getDbCompat();
  inWriteTransaction(getDb(), () => {
    const changed: { rid: number; language: string }[] = [];
    for (const id of ids) {
      const row = db.query(`SELECT rowid AS rid, language FROM operation_library WHERE id = ?`).get(id) as { rid: number; language: string } | null | undefined;
      if (!row) continue;
      changed.push(row);
      db.run(`DELETE FROM operation_library WHERE id = ?`, [id]);
    }
    resealChanged(changed);
  });
}

export function removeByComponentId(componentId: string): void {
  ensureTable();
  const db = getDbCompat();
  const rows = db.query(`SELECT id FROM operation_library WHERE component_id = ?`).all(componentId) as { id: string }[];
  removeEntries(rows.map((r) => r.id));
}

export function compactOperationLibrary(): void {
  ensureTable();
  const db = getDbCompat();
  db.run(`PRAGMA incremental_vacuum`);
}
