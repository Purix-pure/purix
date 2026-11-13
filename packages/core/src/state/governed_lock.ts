// src/state/governed_lock.ts
//
// The committed lock: `purix.lock.json` at the project root. It records, for every governed component, the
// SHA-256 of each governed file, so `purix check` can verify a FRESH CHECKOUT (CI) without the local store.
// The local store lives in the working copy or in the git directory and is never part of a clone, so without
// a committed record CI has nothing to compare against (PURIX-14 R5a).
//
// Same idea as a package lockfile: written by one command (`purix lock`), committed, verified in CI by a
// frozen/strict mode that fails when it no longer matches (pnpm `--frozen-lockfile`, `npm ci`).
//
// What it is NOT: it is not tamper-proof. Anyone who can edit a governed file and the lock in one commit passes
// this check; branch protection and review are what stop that. It carries no file contents, only hashes, and it
// does not contain the audit chain (the chain changes on every event and would make the lock permanently stale).
// Line endings are normalised before hashing so a Windows checkout with autocrlf does not read as an edit.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { writeFileAtomic } from "../platform/atomic_write.js";
import type { ManifestEntry } from "../manifest/schema.js";

export const LOCK_FILENAME = "purix.lock.json";

export interface LockedFile {
  path: string;
  /** null: the file did not exist (or left the project) when the lock was written. */
  sha256: string | null;
}

export interface LockedComponent {
  component_id: string;
  version: number;
  last_synced_hash: string | null;
  files: LockedFile[];
}

export interface GovernedLock {
  schema: 1;
  components: LockedComponent[];
}

export type LockRead = { state: "absent" } | { state: "ok"; lock: GovernedLock } | { state: "damaged"; detail: string };

export interface LockFinding {
  outcome: "fail";
  subject: string;
  message: string;
}

export function lockPath(baseDir: string): string {
  return join(resolve(baseDir), LOCK_FILENAME);
}

/** SHA-256 of a file's text with CRLF normalised to LF. */
export function hashGovernedContent(content: string): string {
  return createHash("sha256").update(content.replace(/\r\n/g, "\n")).digest("hex");
}

function hashFile(baseDir: string, rel: string): string | null {
  const full = resolve(baseDir, rel);
  const r = relative(resolve(baseDir), full);
  if (r === "" || r.startsWith("..") || isAbsolute(r)) return null;
  if (!existsSync(full)) return null;
  try {
    return hashGovernedContent(readFileSync(full, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * What the lock records: components Purix has a sync hash for. The internal "codebase index" row lists every indexed
 * file, owned or not, and has no hash; locking it would make any ordinary edit to an un-adopted file fail CI.
 */
export function isLockable(e: ManifestEntry): boolean {
  return e.component_type !== "codebase_index" && e.last_synced_hash != null;
}

export function buildLock(manifest: ManifestEntry[], baseDir: string): GovernedLock {
  const components = manifest
    .filter(isLockable)
    .sort((a, b) => a.component_id.localeCompare(b.component_id))
    .map((e) => ({
      component_id: e.component_id,
      version: e.current_version,
      last_synced_hash: e.last_synced_hash ?? null,
      files: [...(e.files ?? [])].sort().map((path) => ({ path, sha256: hashFile(baseDir, path) })),
    }));
  return { schema: 1, components };
}

/** Deterministic text: same lock, same bytes, so a commit only changes when governance changed. */
export function serializeLock(lock: GovernedLock): string {
  return JSON.stringify(lock, null, 2) + "\n";
}

export function writeLock(baseDir: string, lock: GovernedLock): string {
  const p = lockPath(baseDir);
  writeFileAtomic(p, serializeLock(lock), { mkdir: false });
  return p;
}

export function readLock(baseDir: string): LockRead {
  const p = lockPath(baseDir);
  if (!existsSync(p)) return { state: "absent" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(p, "utf-8"));
  } catch (err) {
    return { state: "damaged", detail: `not valid JSON (${err instanceof Error ? err.message : String(err)})` };
  }
  const lock = parsed as Partial<GovernedLock> | null;
  if (lock && typeof lock.schema === "number" && lock.schema > 1) {
    return { state: "damaged", detail: `written by a newer Purix (lock schema ${lock.schema}; this Purix reads schema 1). Upgrade Purix, then run the command again` };
  }
  if (!lock || lock.schema !== 1 || !Array.isArray(lock.components)) return { state: "damaged", detail: "unknown shape or schema version" };
  for (const c of lock.components) {
    const okFiles = Array.isArray(c?.files) && c.files.every((f) => typeof f?.path === "string" && (f.sha256 === null || typeof f.sha256 === "string"));
    if (typeof c?.component_id !== "string" || typeof c?.version !== "number" || !okFiles) {
      return { state: "damaged", detail: "a component entry is malformed" };
    }
  }
  return { state: "ok", lock: lock as GovernedLock };
}

/** Compares the files on disk with the lock. Used when there is no local store (a fresh checkout). */
export function verifyFilesAgainstLock(lock: GovernedLock, baseDir: string): LockFinding[] {
  const out: LockFinding[] = [];
  for (const c of lock.components) {
    for (const f of c.files) {
      if (f.sha256 === null) {
        out.push({ outcome: "fail", subject: c.component_id, message: `${f.path}: was missing when the lock was written, so it cannot be checked. Run "purix lock" again.` });
        continue;
      }
      const now = hashFile(baseDir, f.path);
      if (now === null) out.push({ outcome: "fail", subject: c.component_id, message: `${f.path}: file is missing or leaves the project` });
      else if (now !== f.sha256) out.push({ outcome: "fail", subject: c.component_id, message: `${f.path}: changed since the lock was written` });
    }
  }
  return out;
}

/** Compares the lock with the local store. A mismatch means the lock was not refreshed after a change. */
export function verifyLockAgainstStore(lock: GovernedLock, manifest: ManifestEntry[]): LockFinding[] {
  const out: LockFinding[] = [];
  const byId = new Map(lock.components.map((c) => [c.component_id, c]));
  for (const e of manifest.filter(isLockable)) {
    const c = byId.get(e.component_id);
    if (!c) out.push({ outcome: "fail", subject: e.component_id, message: `governed here but not in ${LOCK_FILENAME}. Run "purix lock" and commit it.` });
    else if (c.last_synced_hash !== (e.last_synced_hash ?? null) || c.version !== e.current_version) {
      out.push({ outcome: "fail", subject: e.component_id, message: `${LOCK_FILENAME} is out of date (it records v${c.version}, the store has v${e.current_version}). Run "purix lock" and commit it.` });
    }
    byId.delete(e.component_id);
  }
  for (const id of byId.keys()) out.push({ outcome: "fail", subject: id, message: `in ${LOCK_FILENAME} but no longer governed here. Run "purix lock" and commit it.` });
  return out;
}

/** After a landed change: rewrite the lock only if the project already keeps one. Returns true when it was rewritten. */
export function refreshLockIfPresent(manifest: ManifestEntry[], baseDir: string): boolean {
  if (!existsSync(lockPath(baseDir))) return false;
  writeLock(baseDir, buildLock(manifest, baseDir));
  return true;
}
