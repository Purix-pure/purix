// packages/core/src/state/repo_lock.ts
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";

interface LockData {
  pid: number;
  timestamp: string;
  /** Refreshed periodically by whoever holds the lock. See STALE_MS below. */
  updatedAt: string;
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

function lockFilePath(baseDir: string): string {
  return join(baseDir, ".purix", "repo.lock");
}

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

function writeLock(baseDir: string): void {
  const now = new Date().toISOString();
  const lockData: LockData = { pid: process.pid, timestamp: now, updatedAt: now };
  writeFileSync(lockFilePath(baseDir), JSON.stringify(lockData, null, 2));
}

export function acquireRepoLock(baseDir: string = process.cwd()): void {
  const dir = join(baseDir, ".purix");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const p = lockFilePath(baseDir);
  if (existsSync(p)) {
    try {
      const content = readFileSync(p, "utf8");
      const data = JSON.parse(content) as LockData;
      if (typeof data.pid === "number") {
        let isAlive = false;
        try {
          process.kill(data.pid, 0);
          isAlive = true;
        } catch (err: any) {
          if (err?.code === "EPERM") {
            isAlive = true; // process exists but we lack permission to signal
          }
        }

        // Older lock files (written before this fix) have no updatedAt —
        // fall back to timestamp so they're still treated as reclaimable
        // once old enough, rather than crashing on a missing field.
        const lastBeat = Date.parse(data.updatedAt ?? data.timestamp);
        const staleByAge = !Number.isNaN(lastBeat) && Date.now() - lastBeat > STALE_MS;

        if (isAlive && !staleByAge) {
          throw new Error(`Repository is already locked by active process PID ${data.pid}.`);
        } else {
          console.log(
            !isAlive
              ? `  [repo_lock] Clearing stale lock from dead PID ${data.pid}.`
              : `  [repo_lock] Clearing abandoned lock (PID ${data.pid} is alive but hasn't ` +
                  `refreshed the lock in ${Math.round((Date.now() - lastBeat) / 1000)}s — ` +
                  `treating as a different process than the one that created it).`,
          );
          try {
            unlinkSync(p);
          } catch { /* removing a stale/corrupt lock file is best-effort */ }
        }
      }
    } catch (err: any) {
      if (err instanceof Error && err.message.includes("already locked")) {
        throw err;
      }
      // Corrupt lock file or read error — remove it
      try {
        unlinkSync(p);
      } catch { /* removing a stale/corrupt lock file is best-effort */ }
    }
  }

  writeLock(baseDir);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => writeLock(baseDir), HEARTBEAT_MS);
  heartbeatTimer.unref?.();
}

export function releaseRepoLock(baseDir: string = process.cwd()): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  const p = lockFilePath(baseDir);
  if (!existsSync(p)) return;
  try {
    const content = readFileSync(p, "utf8");
    const data = JSON.parse(content) as LockData;
    if (data.pid === process.pid) {
      unlinkSync(p);
    }
  } catch {
    try {
      unlinkSync(p);
    } catch { /* removing a stale/corrupt lock file is best-effort */ }
  }
}