// packages/core/src/state/repo_lock.ts
import { existsSync, readFileSync, unlinkSync, mkdirSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";
import { createFileExclusive, moveFileAside, readJsonFile, writeFileAtomic } from "../platform/atomic_write.js";
import { sleepSync } from "../platform/sleep_sync.js";
import { purixDir } from "../platform/layout.js";

interface LockData {
  pid: number;
  timestamp: string;
  /** Refreshed periodically by whoever holds the lock. See STALE_MS below. */
  updatedAt: string;
  /**
   * Random per acquisition. Lets a holder tell "the lock on disk is mine" from "someone reclaimed it and now
   * holds their own". Absent in lock files written by older versions.
   */
  token?: string;
}

// A live PID is necessary but not sufficient proof the lock is still held:
// operating systems recycle PIDs, so a lock abandoned by a killed/crashed
// process can later appear "alive" simply because some unrelated process
// (observed in practice: a Windows svchost.exe) was later assigned that
// same PID. The heartbeat is what actually proves the original holder is
// still around — an unrelated process doesn't know our lock file exists,
// so it can never refresh updatedAt. If a lock's heartbeat is older than
// this, it's abandoned regardless of what currently lives at its PID.
const STALE_MS = 30_000;
const HEARTBEAT_MS = 10_000;
/** How far ahead of our own clock a recorded heartbeat may be before it is treated as a clock error. */
const CLOCK_SKEW_ALLOWANCE_MS = 5 * 60_000;
// The two numbers above, behind one object so a test can shorten them (a 60 s blocked verification would otherwise take 60 s
// to test). Production code never calls setLockTimingForTests.
const timing = { staleMs: STALE_MS, heartbeatMs: HEARTBEAT_MS };
export function setLockTimingForTests(t: { staleMs?: number; heartbeatMs?: number }): void {
  if (t.staleMs !== undefined) timing.staleMs = t.staleMs;
  if (t.heartbeatMs !== undefined) timing.heartbeatMs = t.heartbeatMs;
}
const ACQUIRE_ATTEMPTS = 5;
// Where hard links work, a lock file appears complete. Where they do not (exFAT/FAT32, some network mounts),
// createFileExclusive falls back to open("wx"), and the file exists, empty, for a moment before its content is
// written. An unreadable lock younger than FRESH_MS is therefore "being written", never "damaged": wait for it,
// do not delete it. Only an older unreadable lock (its creator died mid-write) is reclaimed.
const FRESH_MS = 2_000;
const FRESH_WAIT_MS = 1_000;
const POLL_MS = 25;

function ageMs(path: string): number {
  try {
    const age = Date.now() - statSync(path).mtimeMs;
    // H4 clock moved backwards: a stamp further ahead than the allowance is not a write in progress; treat it as old.
    return age < -CLOCK_SKEW_ALLOWANCE_MS ? Number.POSITIVE_INFINITY : age;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function lockFilePath(baseDir: string): string {
  return join(purixDir(baseDir), "repo.lock");
}

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let heldToken: string | null = null;

function serialize(data: LockData): string {
  return JSON.stringify(data, null, 2);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM"; // process exists but we lack permission to signal
  }
}

// Older lock files (written before the heartbeat fix) have no updatedAt — fall back to timestamp so they're
// still treated as reclaimable once old enough, rather than crashing on a missing field.
//
// The file's own modification time counts as a beat too. The heartbeat worker (below) refreshes the lock by touching it, not by
// rewriting its JSON, because a touch can never recreate a lock file that was just released; an older holder that rewrites the
// JSON also moves the mtime, so "newer of the two" is right for both.
function lastBeatMs(data: LockData, lockPath: string): number {
  let recorded = Date.parse(data.updatedAt ?? data.timestamp);
  // A2b clock skew: a beat more than a few minutes ahead of our clock was written by a clock that is wrong (or was). Believing
  // it would keep a dead holder's lock alive until our clock caught up. Ignore it and go by the file's own modification time.
  if (recorded > Date.now() + CLOCK_SKEW_ALLOWANCE_MS) recorded = Number.NaN;
  let touched = Number.NaN;
  try {
    touched = statSync(lockPath).mtimeMs;
  } catch {
    // the file vanished between our read and now; the JSON value is all there is
  }
  return Number.isNaN(recorded) ? touched : Number.isNaN(touched) ? recorded : Math.max(recorded, touched);
}

/**
 * Removes a lock we have judged abandoned, without deleting a lock someone else has just created. Two processes
 * can both judge the same lock stale; a plain unlink by the slower one would delete the faster one's fresh lock.
 * So: move the file aside (rename, which only one of them can win), check that what we moved is what we judged,
 * and if it is not, put it back.
 *
 * Narrow window that remains: if we moved a fresh lock and the put-back finds a third process has already
 * created one, the moved lock's holder has lost it. That holder notices at its next heartbeat (token check).
 */
function reclaim(path: string, judged: ReturnType<typeof readJsonFile<LockData>>): void {
  const aside = `${path}.reclaim.${randomBytes(4).toString("hex")}`;
  try {
    moveFileAside(path, aside, { retries: 2 });
  } catch {
    return; // someone else already moved or removed it
  }
  const moved = readJsonFile<LockData>(aside);
  const same =
    judged.kind === "corrupt"
      ? moved.kind === "corrupt"
      : judged.kind === "ok" && moved.kind === "ok" && JSON.stringify(moved.value) === JSON.stringify(judged.value);
  if (!same) {
    try {
      createFileExclusive(path, readFileSync(aside, "utf-8"));
    } catch {
      // could not put it back; see the note above
    }
  }
  try {
    unlinkSync(aside);
  } catch {
    // best-effort
  }
}

// The heartbeat has to run on a thread that a blocked main thread cannot stop. Verification runs through spawnSync, which blocks
// the main thread for as long as the child runs, so a timer on that thread went silent for a verification longer than
// STALE_MS and a second process took the lock from a holder that was alive (research 11; reproduced). This worker has its own
// event loop: every interval it checks that the lock file still carries our token and, if so, touches it. It never writes
// the file's content and never creates it. It ends itself when the file is gone or carries another token.
const HEARTBEAT_WORKER_SOURCE = `
// getBuiltinModule works in both module systems: a worker started from a process run with --input-type=module (or NODE_OPTIONS
// carrying it) is parsed as an ES module, where require does not exist, and a worker that dies at start-up is silent.
const fs = process.getBuiltinModule("node:fs");
const { path, token, intervalMs } = process.getBuiltinModule("node:worker_threads").workerData;
setInterval(() => {
  let current;
  try {
    current = JSON.parse(fs.readFileSync(path, "utf8"));
  } catch (err) {
    if (err && err.code === "ENOENT") process.exit(0);
    return; // unreadable for a moment (being replaced): try again next tick
  }
  if (current.token !== token) process.exit(0);
  try {
    const now = new Date();
    fs.utimesSync(path, now, now);
  } catch (err) {
    if (err && err.code === "ENOENT") process.exit(0);
  }
}, intervalMs);
`;

let heartbeatWorker: Worker | null = null;

function startHeartbeatWorker(path: string, token: string): void {
  stopHeartbeatWorker();
  try {
    const w = new Worker(HEARTBEAT_WORKER_SOURCE, { eval: true, execArgv: [], workerData: { path, token, intervalMs: timing.heartbeatMs } });
    w.on("error", () => {
      // A heartbeat problem must never become an uncaught exception in the command that holds the lock; the timer on the
      // main thread is still beating whenever that thread is free.
    });
    w.unref();
    heartbeatWorker = w;
  } catch {
    heartbeatWorker = null; // no worker threads here: the main-thread timer alone, as before
  }
}

function stopHeartbeatWorker(): void {
  const w = heartbeatWorker;
  heartbeatWorker = null;
  if (w) void w.terminate().catch(() => undefined);
}

function beat(baseDir: string, token: string, acquiredAt: string): void {
  const p = lockFilePath(baseDir);
  const current = readJsonFile<LockData>(p);
  if (current.kind === "corrupt") return; // possibly a transient read problem; try again next tick
  if (current.kind === "missing" || current.value.token !== token) {
    // Someone reclaimed the lock (we stalled past STALE_MS) or removed it. It is no longer ours: stop, and do
    // NOT write, or we would overwrite the new holder's lock.
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    stopHeartbeatWorker();
    return;
  }
  try {
    // Atomic: a plain write truncates first, and a reader landing in that gap saw empty JSON.
    writeFileAtomic(p, serialize({ pid: process.pid, timestamp: acquiredAt, updatedAt: new Date().toISOString(), token }));
  } catch {
    // A missed beat is not fatal: STALE_MS is three heartbeats, so the next tick can still land in time.
    // Throwing here would be an uncaught exception from a timer (the rename can fail on Windows while another
    // process has the file open, once the bounded retry is used up).
  }
}

export function acquireRepoLock(baseDir: string = process.cwd()): void {
  const p = lockFilePath(baseDir);
  mkdirSync(dirname(p), { recursive: true });

  for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt++) {
    const now = new Date().toISOString();
    const mine: LockData = { pid: process.pid, timestamp: now, updatedAt: now, token: randomBytes(8).toString("hex") };

    // The one step that decides who holds the lock: create the file only if it does not exist.
    if (createFileExclusive(p, serialize(mine))) {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heldToken = mine.token!;
      heartbeatTimer = setInterval(() => beat(baseDir, mine.token!, now), timing.heartbeatMs);
      heartbeatTimer.unref?.();
      startHeartbeatWorker(p, mine.token!);
      return;
    }

    let existing = readJsonFile<LockData>(p);
    if (existing.kind === "missing") continue; // released between our create attempt and our read; try again
    for (let waited = 0; existing.kind === "corrupt" && ageMs(p) < FRESH_MS && waited < FRESH_WAIT_MS; waited += POLL_MS) {
      sleepSync(POLL_MS);
      existing = readJsonFile<LockData>(p);
    }
    if (existing.kind === "missing") continue;
    if (existing.kind === "corrupt" && ageMs(p) < FRESH_MS) {
      throw new Error(`Could not acquire the repository lock: ${p} is being written by another process. Try again in a moment.`);
    }
    if (existing.kind === "ok" && typeof existing.value.pid === "number") {
      const alive = isAlive(existing.value.pid);
      const lastBeat = lastBeatMs(existing.value, p);
      const staleByAge = !Number.isNaN(lastBeat) && Date.now() - lastBeat > timing.staleMs;
      if (alive && !staleByAge) {
        throw new Error(`Repository is already locked by active process PID ${existing.value.pid}.`);
      }
      console.log(
        !alive
          ? `  [repo_lock] Clearing stale lock from dead PID ${existing.value.pid}.`
          : `  [repo_lock] Clearing abandoned lock (PID ${existing.value.pid} is alive but hasn't ` +
              `refreshed the lock in ${Math.round((Date.now() - lastBeat) / 1000)}s — ` +
              `treating as a different process than the one that created it).`,
      );
    }
    // Stale, or unreadable / not a lock file: remove it (safely) and go round again to create our own.
    reclaim(p, existing);
  }
  throw new Error("Could not acquire the repository lock: it kept changing while we tried. Try again.");
}

/** True if the lock file on disk is the one this process acquired (same token). False if absent, replaced, or never acquired. */
export function isRepoLockHeld(baseDir: string = process.cwd()): boolean {
  if (heldToken === null) return false;
  const current = readJsonFile<LockData>(lockFilePath(baseDir));
  return current.kind === "ok" && current.value.token === heldToken;
}

/**
 * For the write step: throws unless this process still holds the lock it acquired. A holder that stalled past the staleness
 * window, or whose lock file was removed, must not go on writing the project's files. The write step calls it before the
 * first write and before every file (manifest/commit_and_cascade.ts passes it as lockCheck).
 */
export function assertRepoLockHeld(baseDir: string = process.cwd()): void {
  if (!isRepoLockHeld(baseDir)) {
    throw new Error("This process no longer holds the repository lock (it expired or another process took it), so it will not write. Run the command again.");
  }
}

export function releaseRepoLock(baseDir: string = process.cwd()): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  stopHeartbeatWorker();
  const token = heldToken;
  heldToken = null;
  const p = lockFilePath(baseDir);
  if (!existsSync(p)) return;
  try {
    const content = readFileSync(p, "utf8");
    const data = JSON.parse(content) as LockData;
    // Ours if the token matches; a lock from an older version has no token, so fall back to the pid.
    const ours = data.token !== undefined ? data.token === token : data.pid === process.pid;
    if (ours) unlinkSync(p);
  } catch {
    // Unreadable: not provably ours (a held lock was complete when we created it), so leave it. Deleting it
    // here could remove another process's lock that is still being written.
  }
}
