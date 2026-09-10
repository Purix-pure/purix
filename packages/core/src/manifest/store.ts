// src/manifest/store.ts
//
// Runtime migration (ADR-009, ADR-016): this file previously used
// bun:sqlite. It now uses Node's built-in node:sqlite (DatabaseSync),
// the driver ADR-016 specifies — no native compile step on install,
// matching this project's "installed by strangers via a package
// runner" constraint. Two real API differences from bun:sqlite drove
// changes below, both isolated to this file so nothing calling these
// exported functions had to change:
//
//   1. node:sqlite has no `.query(sql).get()/.all()` convenience layer —
//      statements are prepared once via `db.prepare(sql)` and then
//      called with `.get(...args)` / `.all(...args)` / `.run(...args)`,
//      spreading positional params rather than passing an array.
//   2. node:sqlite has no built-in `.transaction()` helper (bun:sqlite
//      and better-sqlite3 both have one; node:sqlite doesn't as of the
//      version this project's floor targets). withTransaction() below
//      is a hand-written BEGIN IMMEDIATE / COMMIT / ROLLBACK wrapper —
//      BEGIN IMMEDIATE specifically, not the default deferred BEGIN, so
//      the write lock is acquired up front. That matters for
//      writeManifestWithLimitCheck's count-then-insert: with a deferred
//      BEGIN, two concurrent transactions could each pass the SELECT
//      COUNT check before either acquires the write lock, both then
//      insert, and the limit check they both "passed" is worthless. An
//      IMMEDIATE transaction closes that window.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ManifestEntry, VerificationStatus, Provenance } from "./schema.js";
import { migrateManifestEntry } from "./schema_migrations.js";
import { checkComponentLimit } from "../licensing/tier.js";
import { CompatDb } from "../platform/sqlite_compat.js";
import { resolveSharedStateDir } from "../state/git_common_dir.js";

// ADR-041: this path must resolve to the repository's common git
// directory (shared across every worktree), not a path under the
// per-worktree working directory — see git_common_dir.ts. Computed at
// call time (not module load) so it tracks process.cwd(), matching how
// tests already isolate themselves via process.chdir() per test.
function resolveDbPath(): string {
  return join(resolveSharedStateDir(), "manifest.db");
}

let _db: DatabaseSync | null = null;
let _dbPath: string | null = null;

const DEFAULT_PROVENANCE: Provenance = { source_type: "instruction", source_agent: null };

export function getDb(): DatabaseSync {
  if (_db) return _db;
  const dbPath = resolveDbPath();
  _dbPath = dbPath;
  mkdirSync(dirname(dbPath), { recursive: true });
  _db = new DatabaseSync(dbPath);
  _db.exec(`PRAGMA journal_mode = WAL;`);

  const integrity = _db.prepare(`PRAGMA integrity_check`).get() as { integrity_check: string } | undefined;
  if (!integrity || integrity.integrity_check !== "ok") {
    console.error(`\n🛑 CRITICAL: SQLite storage corruption detected (${integrity?.integrity_check ?? "unknown"}). Rebuilding database...`);
    console.warn(`   Warning: Local-only state including Operation Library, burn-guard ledger, and un-synced audit records have been reset.`);
    _db.close();
    try {
      unlinkSync(dbPath);
    } catch {}
    _db = new DatabaseSync(dbPath);
    _db.exec(`PRAGMA journal_mode = WAL;`);
  }

  _db.exec(`
    CREATE TABLE IF NOT EXISTS manifest (
      component_id TEXT PRIMARY KEY,
      data TEXT NOT NULL
    )
  `);
  _db.exec(`
    CREATE TABLE IF NOT EXISTS pending_operations (
      id TEXT PRIMARY KEY,
      component_id TEXT NOT NULL,
      status TEXT NOT NULL,
      before_snapshot TEXT NOT NULL,
      after_snapshot TEXT NOT NULL,
      new_version INTEGER NOT NULL,
      operation TEXT NOT NULL,
      contract_changed INTEGER NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  // v1.0 §4.1 Must-have: provenance now travels with a pending operation
  // too, so a crash-recovered commit (reconcile.ts) can record the real
  // origin instead of guessing at reconciliation time. ADD COLUMN throws
  // on a DB that already has this column — that's still the simplest
  // reliable way to tell "already migrated" from "fresh table" under
  // node:sqlite, so the caught failure here is expected, not swallowed
  // silently.
  try {
    _db.exec(`ALTER TABLE pending_operations ADD COLUMN provenance TEXT`);
  } catch {
    // column already exists — already migrated, nothing to do
  }
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
    _dbPath = null;
  }
}

/**
 * bun:sqlite-shaped wrapper around the same underlying connection getDb()
 * returns — for the several other files in this package that still call
 * the old .query()/.run() convenience shape directly. See
 * platform/sqlite_compat.ts's header for why this exists instead of
 * hand-migrating each of those call sites' SQL by eye. Each call opens a
 * fresh lightweight wrapper around the same singleton connection — no
 * separate connection or transaction state, just the shape adapter.
 */
export function getDbCompat(): CompatDb {
  return new CompatDb(getDb());
}

/**
 * node:sqlite has no built-in `.transaction()` helper. BEGIN IMMEDIATE
 * (not the default deferred BEGIN) acquires the write lock up front —
 * see the file header comment for why writeManifestWithLimitCheck
 * depends on that specifically.
 */
function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // if the transaction was never actually opened (e.g. BEGIN itself
      // threw SQLITE_BUSY), there's nothing to roll back — surface the
      // original error, not a secondary rollback failure
    }
    throw err;
  }
}

export function writeManifest(entry: ManifestEntry): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO manifest (component_id, data) VALUES (?, ?)
     ON CONFLICT(component_id) DO UPDATE SET data = excluded.data`
  ).run(entry.component_id, JSON.stringify(entry));
}

/**
 * Part 5: checkComponentLimit() wiring. The count-check and the insert
 * happen inside one withTransaction() (node:sqlite, single connection,
 * WAL mode, BEGIN IMMEDIATE — see file header) so there's no window
 * between "count is under the limit" and "row inserted" for a
 * concurrent `purix create` to slip through — a check-and-reserve, not
 * a pre-check followed by a separate write.
 *
 * Only counts against the limit when component_id is genuinely new:
 * writeManifest is an upsert (ON CONFLICT DO UPDATE), so re-registering
 * an already-tracked component must never trip the limit — only counting
 * rows that don't exist yet keeps that upsert semantics intact.
 */
export function writeManifestWithLimitCheck(entry: ManifestEntry): void {
  const db = getDb();
  withTransaction(db, () => {
    const existing = db.prepare("SELECT 1 FROM manifest WHERE component_id = ?").get(entry.component_id);
    if (!existing) {
      const countRow = db.prepare("SELECT COUNT(*) as count FROM manifest").get() as { count: number };
      checkComponentLimit(countRow.count); // throws (aborting the transaction) if this new component would exceed the limit
    }
    db.prepare(
      `INSERT INTO manifest (component_id, data) VALUES (?, ?)
       ON CONFLICT(component_id) DO UPDATE SET data = excluded.data`
    ).run(entry.component_id, JSON.stringify(entry));
  });
}

export function readManifest(componentId: string): ManifestEntry | null {
  const db = getDb();
  const row = db.prepare("SELECT data FROM manifest WHERE component_id = ?").get(componentId) as
    | { data: string }
    | undefined;
  if (!row) return null;

  const raw = JSON.parse(row.data) as ManifestEntry;
  const { entry, migrated } = migrateManifestEntry(raw);
  if (migrated) {
    console.log(`  [schema] migrated "${componentId}" to schema_version ${entry.schema_version} on read.`);
    writeManifest(entry);
  }
  return entry;
}

export function listManifest(): ManifestEntry[] {
  const db = getDb();
  const rows = db.prepare("SELECT data FROM manifest").all() as { data: string }[];
  return rows.map((r) => {
    const raw = JSON.parse(r.data) as ManifestEntry;
    const { entry, migrated } = migrateManifestEntry(raw);
    if (migrated) writeManifest(entry);
    return entry;
  });
}

export function updateVerificationStatus(componentId: string, status: VerificationStatus): void {
  const entry = readManifest(componentId);
  if (!entry) throw new Error(`updateVerificationStatus: no manifest entry for "${componentId}"`);
  entry.verification_status = status;
  writeManifest(entry);
}

export function deleteManifestEntry(componentId: string): void {
  const db = getDb();
  db.prepare(`DELETE FROM manifest WHERE component_id = ?`).run(componentId);
}

export function addDependent(targetId: string, dependentId: string): void {
  const entry = readManifest(targetId);
  if (!entry) {
    console.warn(`  warning: depends_on references "${targetId}" but no manifest entry exists for it yet`);
    return;
  }
  if (!entry.depended_on_by.includes(dependentId)) {
    entry.depended_on_by.push(dependentId);
    writeManifest(entry);
  }
}

export function removeDependent(targetId: string, dependentId: string): void {
  const entry = readManifest(targetId);
  if (!entry) return;
  const idx = entry.depended_on_by.indexOf(dependentId);
  if (idx !== -1) {
    entry.depended_on_by.splice(idx, 1);
    writeManifest(entry);
  }
}

/**
 * The other direction of removeDependent: strips `removedId` out of
 * `dependentId`'s own depends_on list. Needed by a forced component
 * delete — deleteManifestEntry only removes the deleted row itself, it
 * never touches other components' depends_on arrays, so without this a
 * forced delete leaves every dependent still listing a component_id
 * that no longer resolves via readManifest.
 */
export function removeDependencyReference(dependentId: string, removedId: string): void {
  const entry = readManifest(dependentId);
  if (!entry) return;
  const idx = entry.depends_on.indexOf(removedId);
  if (idx !== -1) {
    entry.depends_on.splice(idx, 1);
    writeManifest(entry);
  }
}

export interface LinkResult {
  linked: string[];
  skippedSelfRef: string[];
  skippedNotFound: string[];
}

export function linkComponents(componentId: string, dependsOnIds: string[]): LinkResult {
  const entry = readManifest(componentId);
  if (!entry) throw new Error(`linkComponents: no manifest entry for "${componentId}"`);

  const linked: string[] = [];
  const skippedSelfRef: string[] = [];
  const skippedNotFound: string[] = [];

  for (const depId of dependsOnIds) {
    if (depId === componentId) {
      skippedSelfRef.push(depId);
      continue;
    }
    const target = readManifest(depId);
    if (!target) {
      skippedNotFound.push(depId);
      continue;
    }
    if (!entry.depends_on.includes(depId)) entry.depends_on.push(depId);
    linked.push(depId);
  }

  if (linked.length > 0) {
    writeManifest(entry);
    for (const depId of linked) addDependent(depId, componentId);
  }

  return { linked, skippedSelfRef, skippedNotFound };
}

// --- Atomic commit journal (§7.3 / §7.4) ---

export interface FileSnapshot {
  path: string;
  content: string;
}

export interface PendingOperation {
  id: string;
  component_id: string;
  status: string;
  before_snapshot: FileSnapshot[];
  after_snapshot: FileSnapshot[];
  new_version: number;
  operation: string;
  contract_changed: boolean;
  created_at: string;
  provenance: Provenance;
}

export function createPendingOperation(op: {
  component_id: string;
  before_snapshot: FileSnapshot[];
  after_snapshot: FileSnapshot[];
  new_version: number;
  operation: string;
  contract_changed: boolean;
  provenance?: Provenance;
}): string {
  const db = getDb();
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO pending_operations
     (id, component_id, status, before_snapshot, after_snapshot, new_version, operation, contract_changed, created_at, provenance)
     VALUES (?, ?, 'in_progress', ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    op.component_id,
    JSON.stringify(op.before_snapshot),
    JSON.stringify(op.after_snapshot),
    op.new_version,
    op.operation,
    op.contract_changed ? 1 : 0,
    new Date().toISOString(),
    JSON.stringify(op.provenance ?? DEFAULT_PROVENANCE)
  );
  return id;
}

export function listPendingOperations(): PendingOperation[] {
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM pending_operations`).all() as any[];
  return rows.map((r) => ({
    id: r.id,
    component_id: r.component_id,
    status: r.status,
    before_snapshot: JSON.parse(r.before_snapshot),
    after_snapshot: JSON.parse(r.after_snapshot),
    new_version: r.new_version,
    operation: r.operation,
    contract_changed: !!r.contract_changed,
    created_at: r.created_at,
    // rows written before this migration have provenance = NULL
    provenance: r.provenance ? JSON.parse(r.provenance) : DEFAULT_PROVENANCE,
  }));
}

export function deletePendingOperation(id: string): void {
  const db = getDb();
  db.prepare(`DELETE FROM pending_operations WHERE id = ?`).run(id);
}

export function completeModification(
  entry: ManifestEntry,
  pendingOpId: string,
  expectedVersion: number
): boolean {
  const db = getDb();
  let committed = false;
  withTransaction(db, () => {
    committed = commitManifestVersioned(entry, expectedVersion);
    if (committed) {
      db.prepare(`DELETE FROM pending_operations WHERE id = ?`).run(pendingOpId);
    }
    // if it wasn't committed, we deliberately leave the pending_operation row —
    // reconcile.ts will pick it up next run and figure out what actually landed.
  });
  return committed;
}

/**
 * §7.1: compare-and-swap commit. Only writes if current_version in the
 * STORED row still matches expectedVersion — if another process already
 * committed a newer version, this fails instead of silently clobbering
 * it. Returns false, doesn't throw, so the caller decides how to surface
 * it (there's no real request queue in a local CLI, so v1's honest
 * answer is: tell the human to re-run against fresh state).
 */
export function commitManifestVersioned(entry: ManifestEntry, expectedVersion: number): boolean {
  const db = getDb();
  const result = db
    .prepare(
      `UPDATE manifest SET data = ?
       WHERE component_id = ? AND json_extract(data, '$.current_version') = ?`
    )
    .run(JSON.stringify(entry), entry.component_id, expectedVersion);
  return Number(result.changes) > 0;
}

/**
 * BUG FIX (companion to cli.ts's Node 5 fix): the modify command used to
 * call completeModification() a second, redundant time just to delete
 * the pending_operations row after commitManifestWithRetry had already
 * done the real, backoff-protected commit. That redundant call's own
 * internal write was NOT backoff-protected, so a SQLITE_BUSY there threw
 * uncaught mid-command. This is a plain, retry-wrapped delete instead —
 * no redundant manifest write attached to it.
 */
export async function deletePendingOperationWithRetry(id: string, maxAttempts = 5): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      deletePendingOperation(id);
      return;
    } catch (err: any) {
      const busy = /SQLITE_BUSY|database is locked/i.test(String(err?.message ?? ""));
      if (!busy || attempt === maxAttempts) throw err;
      const waitMs = 50 * 2 ** (attempt - 1);
      console.log(`  [manifest] SQLITE_BUSY on pending-op cleanup — retrying in ${waitMs}ms (attempt ${attempt}/${maxAttempts})`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

// --- §9.1 must-have: manifest backup/restore ---

export interface ManifestBackup {
  exported_at: string;
  manifest: ManifestEntry[];
  pending_operations: PendingOperation[];
}

export function exportManifestData(): ManifestBackup {
  return {
    exported_at: new Date().toISOString(),
    manifest: listManifest(),
    pending_operations: listPendingOperations(),
  };
}

/** Destructive — wipes and replaces both tables in one transaction. */
export function importManifestData(backup: ManifestBackup): void {
  const db = getDb();
  withTransaction(db, () => {
    db.exec(`DELETE FROM manifest`);
    db.exec(`DELETE FROM pending_operations`);
    const insertManifest = db.prepare(`INSERT INTO manifest (component_id, data) VALUES (?, ?)`);
    for (const entry of backup.manifest) {
      insertManifest.run(entry.component_id, JSON.stringify(entry));
    }
    const insertPending = db.prepare(
      `INSERT INTO pending_operations
       (id, component_id, status, before_snapshot, after_snapshot, new_version, operation, contract_changed, created_at, provenance)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const op of backup.pending_operations) {
      insertPending.run(
        op.id,
        op.component_id,
        op.status,
        JSON.stringify(op.before_snapshot),
        JSON.stringify(op.after_snapshot),
        op.new_version,
        op.operation,
        op.contract_changed ? 1 : 0,
        op.created_at,
        JSON.stringify(op.provenance ?? DEFAULT_PROVENANCE)
      );
    }
  });
}

/**
 * §4.1 Must-have / §7.1: retry-with-backoff for manifest writes,
 * DISTINCT from llm/circuit.ts's LLM circuit breaker — that one guards
 * the LLM API, this one guards SQLite's single-writer lock. A real
 * conflict (stale expectedVersion) returns false immediately and is NOT
 * retried, since retrying that would just spin on a version mismatch
 * that backoff can't fix.
 */
export async function commitManifestWithRetry(
  entry: ManifestEntry,
  expectedVersion: number,
  maxAttempts = 5
): Promise<boolean> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return commitManifestVersioned(entry, expectedVersion);
    } catch (err: any) {
      const msg = String(err?.message ?? "");
      const busy = /SQLITE_BUSY|database is locked/i.test(msg);
      if (!busy || attempt === maxAttempts) throw err;
      const waitMs = 50 * 2 ** (attempt - 1);
      console.log(`  [manifest] SQLITE_BUSY — retrying write in ${waitMs}ms (attempt ${attempt}/${maxAttempts})`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  return false;
}