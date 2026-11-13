// packages/core/src/tools/state.ts
//
// ADR-060 D7: where the broker keeps state, and the one way it writes it.
//
// T1 (security review V1/H1/H3): the install records, the tool folders and the tools' binaries live in the USER's state folder
// (<user state>/tools/<project key>/), not in the project. A project is data. Before this, everything sat in
// <project>/.purix/tools, so a cloned repository could carry a record that read as "installed and intact" with the binary set to
// its own script, and a Python virtualenv the installer would reuse. Nothing here reads from, or writes to, the project folder.
//
// <project key> is the first 16 hex characters of a SHA-256 of the project's real path, so two projects never share records
// (the same per-project meaning the records always had) and a project cannot name the folder it will be read from.
// Writing and reading state files is platform/atomic_write.ts (PURIX-21 G7: one atomic writer, not a copy here).
import { existsSync, mkdirSync, readdirSync, realpathSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { createFileExclusive, readJsonFile, writeFileAtomic } from "../platform/atomic_write.js";
import { purixDir } from "../platform/layout.js";
import { userStateDir } from "../usage/consent.js";
import type { LockFile, LockRecord } from "./types.js";

/** The project's real path in one comparable form (symlinks resolved where the folder exists; case-folded on Windows). */
function canonicalProjectPath(baseDir: string): string {
  let p = resolve(baseDir);
  try {
    p = realpathSync(p);
  } catch {
    // a folder that does not exist yet keeps its resolved path
  }
  return process.platform === "win32" ? p.toLowerCase() : p;
}

/** A verification copy is a temporary stand-in for the real project; it reads the real project's tools (see aliasToolState). */
const toolStateAlias = new Map<string, string>();

/**
 * Makes `copyDir` read and write the tool state of `realDir`. Used by the sandbox's verification copy only: the copy lives in a
 * temporary folder Purix made, and the tools installed for the real project must stay the hash-checked originals, linked and never copied.
 */
export function aliasToolState(copyDir: string, realDir: string): void {
  toolStateAlias.set(canonicalProjectPath(copyDir), canonicalProjectPath(realDir));
}

export function unaliasToolState(copyDir: string): void {
  toolStateAlias.delete(canonicalProjectPath(copyDir));
}

export function clearToolStateAliases(): void {
  toolStateAlias.clear();
}

/** Short, stable name for a project's folder under the user's tools state. */
export function projectKey(baseDir: string): string {
  const canonical = canonicalProjectPath(baseDir);
  const real = toolStateAlias.get(canonical) ?? canonical;
  return createHash("sha256").update(real).digest("hex").slice(0, 16);
}

export function toolsDir(baseDir: string): string {
  return join(userStateDir(), "tools", projectKey(baseDir));
}

/** The folder older versions used inside the project. It is never read; it is only looked for, so the person can be told. */
export function legacyProjectToolsDir(baseDir: string): string {
  return join(purixDir(baseDir), "tools");
}

/** True when a pre-T1 tools folder sits in the project. Read-only: lists nothing, trusts nothing. */
export function hasLegacyProjectTools(baseDir: string): boolean {
  return existsSync(legacyProjectToolsDir(baseDir));
}

export function toolDir(baseDir: string, id: string): string {
  return join(toolsDir(baseDir), id);
}
export function lockPath(baseDir: string): string {
  return join(toolsDir(baseDir), "lock.json");
}
export function pendingDir(baseDir: string): string {
  return join(toolsDir(baseDir), "pending");
}

export function recordsDir(baseDir: string): string {
  return join(toolsDir(baseDir), "records");
}

// A tool id becomes a file name. Catalog ids are fixed, but a file name is built from this one, so it is checked here too.
const TOOL_ID = /^[a-z0-9][a-z0-9._-]*$/;
function checkedId(id: string): string {
  if (!TOOL_ID.test(id) || id.includes("..")) throw new Error(`"${id}" is not a valid tool id`);
  return id;
}

/** One install record per tool. A2: two installs write two different files, so neither can overwrite the other's record (research 12 finding 1). */
export function recordPath(baseDir: string, id: string): string {
  return join(recordsDir(baseDir), `${checkedId(id)}.json`);
}

export type LockRead = { kind: "ok"; lock: LockFile } | { kind: "corrupt"; error: string };

function isRecord(v: unknown): v is LockRecord {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return ["id", "package", "version", "method", "lockSha256", "installedAt", "binRelPath"].every((k) => typeof r[k] === "string");
}

/**
 * Every recorded install: the records/<id>.json files, plus the records of an older single lock.json if one exists.
 * A record file wins over the same id in lock.json. Anything unreadable makes the whole state "corrupt" (same rule as before:
 * the broker never guesses what was installed).
 */
export function readLock(baseDir: string): LockRead {
  const byId = new Map<string, LockRecord>();
  const legacy = readJsonFile<unknown>(lockPath(baseDir));
  if (legacy.kind === "corrupt") return { kind: "corrupt", error: legacy.error };
  if (legacy.kind === "ok") {
    const v = legacy.value as { version?: unknown; records?: unknown };
    if (v.version !== 1 || !Array.isArray(v.records) || !v.records.every(isRecord)) {
      return { kind: "corrupt", error: "lock.json does not have the expected shape" };
    }
    for (const r of v.records) byId.set(r.id, r);
  }
  let names: string[] = [];
  try {
    names = readdirSync(recordsDir(baseDir)).filter((n) => n.endsWith(".json")).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return { kind: "corrupt", error: `records folder: ${(err as Error).message}` };
  }
  for (const name of names) {
    const r = readJsonFile<unknown>(join(recordsDir(baseDir), name));
    if (r.kind === "missing") continue; // removed between the listing and the read
    if (r.kind === "corrupt") return { kind: "corrupt", error: `records/${name}: ${r.error}` };
    if (!isRecord(r.value) || `${r.value.id}.json` !== name) return { kind: "corrupt", error: `records/${name} is not a valid install record` };
    byId.set(r.value.id, r.value);
  }
  return { kind: "ok", lock: { version: 1, records: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)) } };
}

/** Write (or replace) this tool's record. Touches no other tool's record. */
export function writeRecord(baseDir: string, record: LockRecord): void {
  mkdirSync(recordsDir(baseDir), { recursive: true });
  writeFileAtomic(recordPath(baseDir, record.id), JSON.stringify(record, null, 2) + "\n");
}

/** Remove this tool's record, from records/ and from an older lock.json. Other tools' records are not touched. */
export function removeRecord(baseDir: string, id: string): void {
  try {
    unlinkSync(recordPath(baseDir, id));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const legacy = readJsonFile<unknown>(lockPath(baseDir));
  if (legacy.kind !== "ok") return;
  const v = legacy.value as { version?: unknown; records?: unknown };
  if (v.version !== 1 || !Array.isArray(v.records) || !v.records.every(isRecord) || !v.records.some((r) => r.id === id)) return;
  writeLock(baseDir, { version: 1, records: v.records.filter((r) => r.id !== id) });
}

/** Writes the older single-file form. The broker no longer uses it; tests and anyone with an old lock.json still can. */
export function writeLock(baseDir: string, lock: LockFile): void {
  const sorted: LockFile = { version: 1, records: lock.records.slice().sort((a, b) => a.id.localeCompare(b.id)) };
  writeFileAtomic(lockPath(baseDir), JSON.stringify(sorted, null, 2) + "\n");
}

// ------------------------------------------------------------ per-tool install lock

export const INSTALL_LOCK_STALE_MS = 15 * 60_000;

export function installLockPath(baseDir: string, id: string): string {
  return join(toolsDir(baseDir), `${checkedId(id)}.installing`);
}

export type InstallLock = { ok: true; release: () => void } | { ok: false; message: string };

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * One installer per tool at a time. Does not wait: a second caller is told the first is still running. A lock is taken over only
 * when it is provably stale (its process is gone, or it is older than `staleMs`); a lock file that cannot be read is treated as
 * held, never deleted. Best effort: two processes finding the same stale lock in the same instant can both take it over.
 */
export function acquireInstallLock(baseDir: string, id: string, opts: { now?: Date; staleMs?: number } = {}): InstallLock {
  const path = installLockPath(baseDir, id);
  const now = opts.now ?? new Date();
  const staleMs = opts.staleMs ?? INSTALL_LOCK_STALE_MS;
  mkdirSync(toolsDir(baseDir), { recursive: true });
  const mine = JSON.stringify({ pid: process.pid, startedAt: now.toISOString() });
  const release = () => {
    // Only remove a lock that is still ours; after a takeover it belongs to someone else.
    const cur = readJsonFile<{ pid?: unknown; startedAt?: unknown }>(path);
    if (cur.kind === "ok" && cur.value.pid === process.pid && cur.value.startedAt === now.toISOString()) {
      try {
        unlinkSync(path);
      } catch {
        // already gone
      }
    }
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    if (createFileExclusive(path, mine)) return { ok: true, release };
    const cur = readJsonFile<{ pid?: unknown; startedAt?: unknown }>(path);
    if (cur.kind === "missing") continue; // released between the two calls
    const held = (what: string): InstallLock => ({ ok: false, message: `Another install of ${id} is already running (${what}).` });
    if (cur.kind === "corrupt" || typeof cur.value.pid !== "number" || typeof cur.value.startedAt !== "string") return held("its lock file is unreadable");
    const age = now.getTime() - Date.parse(cur.value.startedAt);
    if (pidAlive(cur.value.pid) && !(age > staleMs)) return held(`process ${cur.value.pid}`);
    try {
      unlinkSync(path);
    } catch {
      // someone else took it over first; the next loop pass finds out
    }
  }
  return { ok: false, message: `Another install of ${id} is already running.` };
}
