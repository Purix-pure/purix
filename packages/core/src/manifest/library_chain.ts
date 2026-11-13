// src/manifest/library_chain.ts
//
// F05-10 (research 05 finding 10, decision D19, ADR-043): the one place that knows how the operation library's hash chain is built
// and checked. No database access here, so `purix check` (which reads the store read-only) and the library itself share one rule.
//
// The chain is kept per language, in row order. Each row's hash covers the previous row's hash, its task signature, its stored
// edits and its language. A row the library changes on purpose (re-promotion, eviction, removal) is followed by a re-seal of every
// row after it (library.ts), so those changes never read as damage. A row changed or removed by anything else is still seen: the
// stored hash no longer matches.
import { createHash } from "node:crypto";

export const LIBRARY_GENESIS_HASH = "0".repeat(64);

export interface LibraryChainRow {
  task_signature: string;
  /** The stored JSON text of the edits, exactly as written (not re-serialised). */
  edits: string;
  prev_hash: string;
  hash: string;
  language: string;
}

export function libraryRowHash(prevHash: string, taskSignature: string, editsText: string, language: string): string {
  return createHash("sha256").update(`${prevHash}|${taskSignature}|${editsText}|${language}`).digest("hex");
}

export interface LibraryChainVerdict {
  valid: boolean;
  /** Index of the first bad row inside its language's chain (rows of one language, in row order). */
  compromisedIndex?: number;
  language?: string;
  reason?: string;
}

/** Checks one language's rows, given in row order. */
export function verifyOneLanguage(rows: LibraryChainRow[]): LibraryChainVerdict {
  let expectedPrev = LIBRARY_GENESIS_HASH;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.prev_hash !== expectedPrev) {
      return { valid: false, compromisedIndex: i, language: row.language, reason: `Broken prev_hash at library entry index ${i}` };
    }
    if (libraryRowHash(row.prev_hash, row.task_signature, row.edits, row.language) !== row.hash) {
      return { valid: false, compromisedIndex: i, language: row.language, reason: `Hash mismatch at library entry index ${i} (tamper detected)` };
    }
    expectedPrev = row.hash;
  }
  return { valid: true };
}

/** Checks every language's chain. `rows` are in row order across the whole table; each language is checked on its own. */
export function verifyLibraryRows(rows: LibraryChainRow[]): LibraryChainVerdict {
  const byLanguage = new Map<string, LibraryChainRow[]>();
  for (const r of rows) {
    const list = byLanguage.get(r.language);
    if (list) list.push(r);
    else byLanguage.set(r.language, [r]);
  }
  for (const [, list] of byLanguage) {
    const v = verifyOneLanguage(list);
    if (!v.valid) return v;
  }
  return { valid: true };
}
