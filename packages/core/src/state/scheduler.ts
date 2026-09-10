// src/state/scheduler.ts
//
// Single shared scheduler for periodic maintenance tasks (ADR-051, ADR-042 amendment).
// Runs on a configurable interval, gated by the repo lock so maintenance never
// runs while a pipeline run is in progress.
//
// This is intentionally lightweight - no external dependencies, no cron parsing,
// just setInterval with a guard. The interval is read from config so it can be
// tuned or disabled without code changes.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createConfigStore } from "./config.js";
import { compactOperationLibrary } from "../manifest/library.js";
import { verifyAuditChain, pruneAuditChain } from "../security/audit_tamper_evidence.js";

interface ScheduledTask {
  name: string;
  // Part 2 (hot reload) fix: this used to be a plain `intervalMs: number`
  // captured ONCE at registerScheduledTask() call time (which happens at
  // module load, below) from whatever config.get(...) returned at that
  // instant — and it was then never actually consulted by schedulerTick()
  // at all (dead field). A long-lived process (the MCP server) that
  // registered these tasks at startup would carry that stale snapshot for
  // its entire lifetime; `purix config set scheduler.compactionIntervalMs
  // ...` in another process/invocation would have zero effect on it
  // without a restart. Now a getter, re-invoked on every poll, so each
  // tick reads the CURRENT config value fresh (config.ts's readAll() has
  // no cache of its own — see its comment — so this is a real live read,
  // not another layer of caching).
  getIntervalMs: () => number;
  run: () => void;
  lastRunAt: number;
}

let schedulerInterval: ReturnType<typeof setInterval> | null = null;
const tasks: ScheduledTask[] = [];
// How often the scheduler wakes up to check whether any task is due. This
// is deliberately NOT itself config-driven in the same way task intervals
// are (see the getIntervalMs comment above for why hot-reloading the poll
// rate itself would be circular). Overridable via PURIX_SCHEDULER_POLL_MS
// strictly so scheduler_hot_reload.test.ts can drive real end-to-end
// timing in a real long-lived process without a 30-second real-time test;
// production code has no reason to set this.
const POLL_INTERVAL_MS = Number(process.env.PURIX_SCHEDULER_POLL_MS) || 30_000;

function getConfig() {
  return createConfigStore(process.cwd());
}

function isRepoLocked(baseDir: string = process.cwd()): boolean {
  const lockPath = join(baseDir, ".purix", "repo.lock");
  if (!existsSync(lockPath)) return false;
  try {
    const content = readFileSync(lockPath, "utf8");
    const data = JSON.parse(content) as { pid: number; timestamp: string };
    if (typeof data.pid === "number") {
      try {
        process.kill(data.pid, 0);
        return true; // process is alive
      } catch (err: any) {
        if (err?.code === "EPERM") {
          return true; // process exists but we lack permission to signal
        }
        // process is dead - stale lock
        return false;
      }
    }
  } catch {
    // corrupt lock file - treat as unlocked
    return false;
  }
  return false;
}

function runTask(task: ScheduledTask): void {
  if (isRepoLocked()) {
    // Pipeline run in progress - skip this tick
    return;
  }
  try {
    task.run();
  } catch (err) {
    // Surface errors explicitly, not silently
    console.error(`[scheduler] Task "${task.name}" failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function schedulerTick(): void {
  // Live re-read on every poll — see the "scheduler.enabled" comment on
  // startScheduler(). A value of exactly `false` disables every task's
  // NEXT run without needing a restart; existing timers keep polling
  // (cheaply) so re-enabling later doesn't need a restart either.
  if (getConfig().get("scheduler.enabled") === false) return;

  const now = Date.now();
  for (const task of tasks) {
    const intervalMs = task.getIntervalMs();
    if (intervalMs <= 0) continue; // this task disabled via config
    if (now - task.lastRunAt < intervalMs) continue; // not due yet
    task.lastRunAt = now;
    runTask(task);
  }
}

/**
 * `getIntervalMs` is a function, not a number, specifically so a config
 * change to whatever key it reads takes effect on the NEXT poll rather
 * than requiring startScheduler()/registerScheduledTask() to run again.
 */
export function registerScheduledTask(name: string, getIntervalMs: () => number, run: () => void): void {
  tasks.push({ name, getIntervalMs, run, lastRunAt: 0 });
}

export function startScheduler(): void {
  if (schedulerInterval) return; // already running

  // "scheduler.enabled" (checked live in schedulerTick, not here) governs
  // per-task pause/resume without a restart. This one check IS at-start-
  // only because it answers a different question — "should the poll timer
  // itself exist at all" — and starting/stopping that timer is exactly
  // what startScheduler()/stopScheduler() are for; a caller that wants to
  // fully tear the scheduler down still calls stopScheduler() explicitly.
  schedulerInterval = setInterval(schedulerTick, POLL_INTERVAL_MS);
  // Don't keep the process alive just for the scheduler
  if (schedulerInterval.unref) schedulerInterval.unref();

  console.error(`[scheduler] Started, polling every ${POLL_INTERVAL_MS}ms for due tasks`);
}

export function stopScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }
}

// Register default maintenance tasks. Each interval is now a closure over
// a fresh config.get() call (default to 1 hour / 1 day as before) instead
// of a value resolved once here at module-load time — see the
// getIntervalMs comment on ScheduledTask above for why that matters.
registerScheduledTask(
  "operation-library-compaction",
  () => (getConfig().get("scheduler.compactionIntervalMs") as number) ?? 60 * 60 * 1000,
  compactOperationLibrary
);

registerScheduledTask(
  "audit-chain-verification",
  () => (getConfig().get("scheduler.auditVerifyIntervalMs") as number) ?? 60 * 60 * 1000,
  () => {
    const result = verifyAuditChain();
    if (!result.valid) {
      // Explicit non-silent warning on broken chain
      console.error(
        `[scheduler] Audit chain verification FAILED at index ${result.compromisedIndex ?? "unknown"}: ${result.reason}`
      );
    }
  }
);

registerScheduledTask(
  "audit-chain-pruning",
  () => (getConfig().get("scheduler.auditPruneIntervalMs") as number) ?? 24 * 60 * 60 * 1000,
  () => {
    const maxAgeDays = (getConfig().get("scheduler.auditRetentionDays") as number) ?? 90;
    const olderThanMs = maxAgeDays * 24 * 60 * 60 * 1000;
    try {
      pruneAuditChain(olderThanMs);
    } catch (err) {
      console.error(`[scheduler] Audit chain pruning failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
);

/**
 * Test-only escape hatch: resets every registered task's lastRunAt so a
 * test can force "due" state deterministically instead of waiting on real
 * wall-clock time or POLL_INTERVAL_MS. Not exported from the package's
 * public surface on purpose (import directly from this file's path in
 * tests) — production code has no legitimate reason to rewind this.
 */
export function __resetTaskScheduleForTests(): void {
  for (const task of tasks) task.lastRunAt = 0;
}

/**
 * Test-only: invoke the exact same poll logic startScheduler()'s
 * setInterval would eventually call, on demand, so tests can assert
 * hot-reload behavior deterministically instead of waiting on real wall-
 * clock time (POLL_INTERVAL_MS). This calls the real schedulerTick() —
 * it does not fake or shortcut any of the config-read/due-check logic
 * under test, it just removes the timer as the trigger mechanism.
 */
export function __pollOnceForTests(): void {
  schedulerTick();
}