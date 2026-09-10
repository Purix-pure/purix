// packages/core/src/state/repo_lock.ts
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";

interface LockData {
  pid: number;
  timestamp: string;
}

function lockFilePath(baseDir: string): string {
  return join(baseDir, ".purix", "repo.lock");
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

        if (isAlive) {
          throw new Error(`Repository is already locked by active process PID ${data.pid}.`);
        } else {
          console.log(`  [repo_lock] Clearing stale lock from dead PID ${data.pid}.`);
          try {
            unlinkSync(p);
          } catch {}
        }
      }
    } catch (err: any) {
      if (err instanceof Error && err.message.includes("already locked")) {
        throw err;
      }
      // Corrupt lock file or read error — remove it
      try {
        unlinkSync(p);
      } catch {}
    }
  }

  const lockData: LockData = {
    pid: process.pid,
    timestamp: new Date().toISOString(),
  };
  writeFileSync(p, JSON.stringify(lockData, null, 2));
}

export function releaseRepoLock(baseDir: string = process.cwd()): void {
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
    } catch {}
  }
}
