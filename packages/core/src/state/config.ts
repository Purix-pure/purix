// packages/core/src/state/config.ts
//
// Part 2: a generic project-local key-value config store. Nothing like
// this exists elsewhere in the repo — tier-config.json, secrets.enc.json,
// and authorized_operators.json are each single-purpose files with their
// own bespoke read/write code. This backs `purix config set/get/delete`,
// the milestone-upsell rate-limit timestamp, and the milestone threshold
// override — none of it sensitive, so plain JSON, no encryption.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

export type ConfigValue = string | number | boolean;
type ConfigData = Record<string, ConfigValue>;

const WINDOWS_RENAME_RETRIES = 8;
const WINDOWS_RENAME_RETRY_DELAY_MS = 25;

function waitSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Windows (antivirus, the search indexer, another process mid-rename) can make
// a perfectly healthy file briefly unreadable/undeletable with these codes.
// They mean "try again in a moment", never "the file is empty".
const TRANSIENT_FS_CODES = new Set(["EPERM", "EACCES", "EBUSY", "EMFILE", "ENFILE"]);
const TRANSIENT_FS_RETRIES = 40;
const TRANSIENT_FS_RETRY_DELAY_MS = 15;

function isTransientFsError(err: unknown): boolean {
  return TRANSIENT_FS_CODES.has((err as NodeJS.ErrnoException).code ?? "");
}

function renameConfigFile(tmpPath: string, finalPath: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmpPath, finalPath);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const retryable = process.platform === "win32" && (code === "EPERM" || code === "EACCES");
      if (!retryable || attempt >= WINDOWS_RENAME_RETRIES) throw err;
      waitSync(WINDOWS_RENAME_RETRY_DELAY_MS);
    }
  }
}

function configPath(baseDir: string): string {
  return join(baseDir, ".purix", "config.json");
}

function lockPath(baseDir: string): string {
  return join(baseDir, ".purix", "config.lock");
}

const CONFIG_LOCK_RETRIES = 100;
const CONFIG_LOCK_RETRY_DELAY_MS = 20;
// BUG FIX (found via 1-in-20 flaky failures in an external concurrent-write
// audit script, cross-checked against this file): this used to be a single
// wall-clock check — a lock older than CONFIG_LOCK_STALE_MS was assumed
// abandoned and stolen, no matter who held it or whether they were still
// running. Under real load, a legitimate holder can occasionally take
// longer than a few seconds for reasons that have nothing to do with being
// stuck — antivirus scanning .purix/, a loaded CI box, Windows filesystem
// latency — and a second process waiting on the same lock would conclude
// "stale," delete the first holder's lock out from under it, and acquire
// its own. That's two processes mid-read-modify-write at once: the exact
// lost-update race this lock exists to prevent, reintroduced by the
// mechanism meant to keep the lock from deadlocking forever.
//
// Fixed the same way repo_lock.ts already handles this: the lock now
// records who holds it (a PID, written into the lock dir right after
// mkdirSync succeeds — see acquireConfigLock), and staleness is judged by
// whether that PID is still alive, not by age alone. A dead holder's lock
// is stolen immediately, regardless of age. A live holder's lock is never
// stolen on age alone — CONFIG_LOCK_ABANDONED_MS below is only a backstop
// for a holder that's alive but has been wedged (deadlocked, infinite
// loop) far longer than any legitimate read-modify-write ever should be.
const CONFIG_LOCK_ABANDONED_MS = 30_000;
// Only used as a fallback for a lock directory that exists but has no
// readable holder.json — e.g. a lock from before this fix, or one where
// the holder crashed between mkdirSync succeeding and the PID file being
// written (a real but very small window). In that narrow case there's no
// PID to check liveness against, so age is all that's left to go on.
const CONFIG_LOCK_STALE_MS = 5000;

function holderPath(lock: string): string {
  return join(lock, "holder.json");
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we lack permission to signal it
    // — still alive, just not ours to signal.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * BUG FIX (GAPS-REPORT-2 §6): set()/delete() below are a classic
 * read-modify-write — readAll(), mutate the in-memory object, writeAll().
 * writeAll()'s atomic rename (see its own comment) protects a READER from
 * ever seeing a torn/partial file, but does nothing about two WRITERS
 * racing: two processes (two concurrent `purix` CLI invocations, or a CLI
 * command running alongside an MCP server session) each read the same
 * starting state, each compute a different single-key change against
 * that same snapshot, and whichever writeAll() runs second silently
 * overwrites — not merges with — the first writer's change. E.g. process
 * A sets key "x", process B (already mid-read before A's write landed)
 * sets key "y" — B's write never saw "x" in its snapshot, so the final
 * file has "y" but not "x", with no error, no warning, and no trace that
 * "x" was ever set at all.
 *
 * Fixed with a simple cross-platform mutex: mkdirSync() either creates a
 * new directory or fails with EEXIST — that's atomic on both POSIX and
 * Windows, the same guarantee a proper lockfile needs, without adding a
 * dependency for it. Every set()/delete() acquires this lock, does its
 * full read-modify-write while holding it, and releases it — so two
 * concurrent callers now serialize instead of racing, and the second one
 * to run genuinely sees the first one's change in its own readAll().
 */
function stealLockPath(baseDir: string): string {
  return join(baseDir, ".purix", "config.lock.steal");
}

function readHolderPid(lock: string): number | undefined {
  try {
    const pid = (JSON.parse(readFileSync(holderPath(lock), "utf8")) as { pid?: unknown }).pid;
    return typeof pid === "number" ? pid : undefined;
  } catch {
    return undefined;
  }
}

// Is the lock currently at `lock` abandoned? Judged fresh every call — never
// cache the answer across a wait, the lock may have changed hands since.
function isLockStealable(lock: string): boolean {
  const holderPid = readHolderPid(lock);
  const age = Date.now() - statSync(lock).mtimeMs; // throws if the lock vanished
  return typeof holderPid === "number"
    ? !isPidAlive(holderPid) || age > CONFIG_LOCK_ABANDONED_MS
    : age > CONFIG_LOCK_STALE_MS;
}

/**
 * RACE FIX: stealing used to be "decide stale, then rmSync". With two
 * waiters that's a classic TOCTOU: both see the same dead holder, waiter B
 * removes it and takes a fresh lock, then waiter C — still acting on its
 * old verdict — removes B's LIVE lock and takes its own. B and C are now
 * both inside read-modify-write, and one silently loses its write.
 *
 * Fix: stealing is itself serialized behind a second mkdir mutex, and the
 * staleness verdict is re-taken INSIDE it. Only one process can be
 * removing a lock at a time, so whoever gets in second re-checks, sees a
 * live holder, and backs off.
 */
function tryStealStaleLock(baseDir: string, lock: string): boolean {
  const steal = stealLockPath(baseDir);
  try {
    mkdirSync(steal);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST" || isTransientFsError(err)) {
      // Someone else is mid-steal. Break the steal mutex only if it's
      // ancient (its owner crashed) — these critical sections take ms.
      try {
        if (Date.now() - statSync(steal).mtimeMs > CONFIG_LOCK_STALE_MS) {
          rmSync(steal, { recursive: true, force: true });
        }
      } catch { /* gone already — fine */ }
      return false;
    }
    throw err;
  }
  try {
    if (!isLockStealable(lock)) return false; // re-verified under the mutex
    rmSync(lock, { recursive: true, force: true });
    return !existsSync(lock);
  } catch {
    return false; // lock vanished, or Windows still holds a handle — retry via the loop
  } finally {
    try {
      rmSync(steal, { recursive: true, force: true });
    } catch { /* best-effort */ }
  }
}

function acquireConfigLock(baseDir: string): void {
  const dir = dirname(configPath(baseDir));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const lock = lockPath(baseDir);
  for (let attempt = 0; attempt < CONFIG_LOCK_RETRIES; attempt++) {
    try {
      mkdirSync(lock);
      // Record who holds it, so a future waiter can check liveness
      // instead of guessing from age alone. Best-effort: if this write
      // fails, the lock is still held (mkdirSync above already
      // succeeded) — a future waiter just falls back to the age-only
      // path for this one lock.
      try {
        writeFileSync(holderPath(lock), JSON.stringify({ pid: process.pid }));
      } catch { /* best-effort — not load-bearing for the lock itself */ }
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // On Windows, mkdir on a directory that is mid-deletion (someone
      // else's rmSync still has a handle open) reports EPERM/EACCES
      // instead of EEXIST. Same meaning: not available yet, wait.
      if (code !== "EEXIST" && !isTransientFsError(err)) throw err;
      try {
        if (isLockStealable(lock) && tryStealStaleLock(baseDir, lock)) continue;
      } catch {
        continue; // lock vanished between mkdir and stat — holder released it
      }
      waitSync(CONFIG_LOCK_RETRY_DELAY_MS);
    }
  }
  throw new Error(
    `Timed out waiting for the config lock at ${lock} — another process may be stuck holding it. If you're sure nothing else is running, delete that directory manually.`
  );
}

function releaseConfigLock(baseDir: string): void {
  const lock = lockPath(baseDir);
  // Never remove a lock that has since been taken over by someone else
  // (we were judged stale while wedged) — that would evict a live holder.
  const holderPid = readHolderPid(lock);
  if (typeof holderPid === "number" && holderPid !== process.pid) return;
  for (let attempt = 0; attempt <= TRANSIENT_FS_RETRIES; attempt++) {
    try {
      rmSync(lock, { recursive: true, force: true });
      return;
    } catch (err) {
      // EPERM/EBUSY here = a waiter has holder.json open right now
      // (Windows). Retry instead of leaving a lock behind.
      if (!isTransientFsError(err) || attempt >= TRANSIENT_FS_RETRIES) return;
      waitSync(TRANSIENT_FS_RETRY_DELAY_MS);
    }
  }
}

function readAll(baseDir: string): ConfigData {
  const p = configPath(baseDir);
  let raw: string | undefined;
  for (let attempt = 0; ; attempt++) {
    try {
      raw = readFileSync(p, "utf8");
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return {}; // genuinely no config yet
      // BUG FIX: this used to be `catch { return {} }` for EVERYTHING. On
      // Windows a healthy config.json can be momentarily unreadable
      // (EPERM/EBUSY/EACCES while another process's rename or an
      // antivirus scan has it) — and inside set()/delete()/getOrCreate()
      // "return {}" means "start from an empty config and write that
      // back", silently wiping every key another process had saved.
      // Transient errors now retry; anything still failing after that
      // throws instead of being mistaken for an empty file.
      if (!isTransientFsError(err) || attempt >= TRANSIENT_FS_RETRIES) throw err;
      waitSync(TRANSIENT_FS_RETRY_DELAY_MS);
    }
  }
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    // A corrupted or hand-edited config.json degrades to "no overrides
    // set" rather than crashing every command that happens to touch it.
    // Writes are atomic (temp + rename), so this only happens for
    // content that was corrupted outside this module.
    return {};
  }
}

// Hot-reload note (Part 2): readAll() above already re-reads from disk on
// every call — there is no in-memory cache to invalidate — so a config
// change made by one process becomes visible to any other process's next
// get()/all() with no restart needed. The one thing that WAS unsafe for
// that scenario was this function: a plain writeFileSync() truncates the
// destination file before writing the new bytes, so a reader (or a crash
// mid-write, e.g. disk full or the process being killed) could observe a
// truncated/empty/half-written config.json — readAll()'s JSON.parse would
// then throw and silently degrade to "no overrides set" (see readAll's own
// comment), which is a real data-loss/flicker risk for a file two
// processes read and write concurrently. Fixed with the standard
// write-temp-then-rename pattern: write the full new content to a sibling
// temp file, then rename() it over the real path. POSIX and Windows both
// guarantee rename() is atomic with respect to concurrent readers/writers
// on the same filesystem — a reader either sees the old complete file or
// the new complete file, never a partial one.
function writeAll(baseDir: string, data: ConfigData): void {
  const dir = dirname(configPath(baseDir));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const finalPath = configPath(baseDir);
  const tmpPath = join(dir, `.config.json.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  try {
    renameConfigFile(tmpPath, finalPath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch { /* best-effort — this write/cleanup isn't load-bearing for the lock itself */ }
    throw err;
  }
}

export interface ConfigStore {
  get(key: string): ConfigValue | undefined;
  set(key: string, value: ConfigValue): void;
  delete(key: string): void;
  all(): ConfigData;
  getOrCreate(key: string, factory: () => ConfigValue): ConfigValue;
}

/**
 * Bound to a specific project directory (normally process.cwd()) — pass an
 * explicit baseDir in tests so they don't read/write the real repo's
 * .purix/config.json.
 */
export function createConfigStore(baseDir: string): ConfigStore {
  return {
    get(key) {
      return readAll(baseDir)[key];
    },
    set(key, value) {
      acquireConfigLock(baseDir);
      try {
        const data = readAll(baseDir);
        data[key] = value;
        writeAll(baseDir, data);
      } finally {
        releaseConfigLock(baseDir);
      }
    },
    delete(key) {
      acquireConfigLock(baseDir);
      try {
        const data = readAll(baseDir);
        delete data[key];
        writeAll(baseDir, data);
      } finally {
        releaseConfigLock(baseDir);
      }
    },
    all() {
      return readAll(baseDir);
    },
    // CONCURRENCY FIX: an unlocked get()-then-conditionally-set() pair (the
    // shape every previous "read a cached value, mint one if missing"
    // caller used — see state/project_id.ts) is a check-then-act race
    // across processes even though set() itself is safely locked. Two
    // processes can both call get(), both see the key absent (neither's
    // write has landed yet), and each independently mint and use its own
    // value — set()'s lock only protects the two writes from corrupting
    // each other's file, not from both having already happened. Confirmed
    // directly: two real processes racing on getProjectId() with no cached
    // id yet produced two different ids (see project_id.test.ts's
    // multi-process regression test).
    //
    // getOrCreate() closes that window by moving the read INSIDE the same
    // lock set()/delete() already use: whichever caller acquires the lock
    // first computes and persists the value; every other caller, once it
    // gets the lock, re-reads and finds the key already set — and returns
    // THAT value instead of overwriting it with a second, different one.
    // factory() may still run more than once (harmless for a pure
    // computation like randomUUID() or a content hash — only its result
    // ever reaches disk, and only the first writer's result does).
    getOrCreate(key, factory) {
      acquireConfigLock(baseDir);
      try {
        const data = readAll(baseDir);
        const existing = data[key];
        if (existing !== undefined) return existing;
        const value = factory();
        data[key] = value;
        writeAll(baseDir, data);
        return value;
      } finally {
        releaseConfigLock(baseDir);
      }
    },
  };
}

/** Default instance, bound to the current project (process.cwd()). */
export const config: ConfigStore = createConfigStore(process.cwd());