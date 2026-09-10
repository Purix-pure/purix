// src/manifest/library.ts
import { getDb, getDbCompat } from "./store.js";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ChangeEdit } from "../llm/classify.js";
import { createConfigStore } from "../state/config.js";
import { resolveLanguage } from "../language/registry.js";

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
  } catch {}
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

export function enforceEviction(language: string = "typescript"): void {
  const db = getDbCompat();
  const countRow = db.query(`SELECT COUNT(*) as cnt FROM operation_library WHERE language = ?`).get(language) as { cnt: number };
  const maxEntries = getConfig().get("operationLibrary.maxEntries") as number ?? 50000;
  if (countRow.cnt >= maxEntries) {
    db.run(
      `DELETE FROM operation_library WHERE language = ? AND id IN (SELECT id FROM operation_library WHERE language = ? ORDER BY last_used_at ASC LIMIT ?)`,
      [language, language, countRow.cnt - maxEntries + 1]
    );
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
    const prevHash = lastRow?.hash ?? "0000000000000000000000000000000000000000000000000000000000000000";
    const editsStr = JSON.stringify(entry.edits);
    const hashInput = `${prevHash}|${entry.task_signature}|${editsStr}|${lang}`;
    const hash = createHash("sha256").update(hashInput).digest("hex");

    db.run(
      `INSERT INTO operation_library (id, task_signature, component_id, operation, description, edits, promoted_at, last_used_at, usage_count, prev_hash, hash, language)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
       ON CONFLICT(task_signature) DO UPDATE SET
         description = excluded.description, edits = excluded.edits, last_used_at = excluded.last_used_at, prev_hash = excluded.prev_hash, hash = excluded.hash, language = excluded.language`,
      [randomUUID(), entry.task_signature, entry.component_id, entry.operation, entry.description, editsStr, now, now, prevHash, hash, lang]
    );
    dbRaw.exec("COMMIT");
  } catch (err) {
    try {
      dbRaw.exec("ROLLBACK");
    } catch {}
    throw err;
  }
}

export function verifyLibraryChain(language?: string): { valid: boolean; compromisedIndex?: number; reason?: string } {
  ensureTable();
  const db = getDbCompat();
  const query = language
    ? `SELECT task_signature, edits, prev_hash, hash, language FROM operation_library WHERE language = ? ORDER BY rowid ASC`
    : `SELECT task_signature, edits, prev_hash, hash, language FROM operation_library ORDER BY rowid ASC`;
  const rows = (language ? db.query(query).all(language) : db.query(query).all()) as any[];

  let expectedPrevHash = "0000000000000000000000000000000000000000000000000000000000000000";
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.prev_hash !== expectedPrevHash) {
      return { valid: false, compromisedIndex: i, reason: `Broken prev_hash at library entry index ${i}` };
    }
    const hashInput = `${row.prev_hash}|${row.task_signature}|${row.edits}|${row.language}`;
    const calculatedHash = createHash("sha256").update(hashInput).digest("hex");
    if (calculatedHash !== row.hash) {
      return { valid: false, compromisedIndex: i, reason: `Hash mismatch at library entry index ${i} (tamper detected)` };
    }
    expectedPrevHash = row.hash;
  }
  return { valid: true };
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

  return entries.filter((entry) => {
    const fullPath = path.resolve(process.cwd(), entry.component_id);
    const exists = fs.existsSync(fullPath);

    if (!exists) {
      db.run(`DELETE FROM operation_library WHERE id = ?`, [entry.id]);
    }

    return exists;
  });
}

export function clearLibrary(): void {
  ensureTable();
  const db = getDbCompat();
  db.run(`DELETE FROM operation_library`);
}

export function removeByComponentId(componentId: string): void {
  ensureTable();
  const db = getDbCompat();
  db.run(`DELETE FROM operation_library WHERE component_id = ?`, [componentId]);
}

export function compactOperationLibrary(): void {
  ensureTable();
  const db = getDbCompat();
  db.run(`PRAGMA incremental_vacuum`);
}
