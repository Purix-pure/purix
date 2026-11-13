// src/state/scheduler.ts
//
// Single shared scheduler for periodic maintenance tasks (ADR-043, ADR-037 amendment, formerly ADR-051/ADR-042).
// Runs on a configurable interval, gated by the repo lock so maintenance never
// runs while a pipeline run is in progress.
//
// This is intentionally lightweight - no external dependencies, no cron parsing,
// just setInterval with a guard. The interval is read from config so it can be
// tuned or disabled without code changes.

import { purixEnv } from "../platform/env.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createConfigStore } from "./config.js";
import { compactOperationLibrary } from "../manifest/library.js";
import { isDatabaseBusy } from "../platform/db_busy.js";
import { pruneEvents } from "../manifest/events.js";
import { pruneCallLog } from "../llm/call_log.js";
import { exportAuditChainJson, pruneAuditChain, verifyAuditChainWithReceipt } from "../security/audit_tamper_evidence.js";
import { verifyOverrideAudits } from "../security/override_audit.js";
import { purixDir } from "../platform/layout.js";
import { storeExists } from "../manifest/store.js";
import { createFileExclusive, writeFileAtomic, writeJsonAtomic } from "../platform/atomic_write.js";
import { resolveSharedStateDir } from "./git_common_dir.js";
import { userStateDir } from "../usage/consent.js";
import { mkdirSync, readFileSync as readFileSyncFs } from "node:fs";
import { randomBytes } from "node:crypto";

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
const POLL_INTERVAL_MS = Number(purixEnv("PURIX_SCHEDULER_POLL_MS")) || 30_000;

function getConfig() {
  return createConfigStore(process.cwd());
}

function isRepoLocked(baseDir: string = process.cwd()): boolean {
  const lockPath = join(purixDir(baseDir), "repo.lock");
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

// --- A2a-1: audit-chain check and export ------------------------------------------------------------------------------------

export interface AuditVerifyStatus {
  /**
   * ok: nothing wrong found. failed: see `problems`. no_store: nothing to check (and nothing was created).
   * busy (H5): another Purix process held the store, so there is no verdict this time. It is returned, never stored: the last
   * real verdict stays in the status file, and a lock is not reported as a tamper finding.
   */
  state: "ok" | "failed" | "no_store" | "busy";
  checkedAt: string;
  records: number;
  /** How the head receipt related to the chain: matches, behind, ahead_of_chain, absent, unreadable, not_checked. */
  receipt: string;
  problems: string[];
  /** Things worth seeing that are not failures (no receipt yet, an unreadable receipt, override rows with no chain record). */
  warnings: string[];
}

function auditStatusPath(): string {
  return join(resolveSharedStateDir(), "audit-verify.json");
}

/** The result of the last check, for `purix status` and `purix doctor` to show. Null when no check has been stored. */
export function readAuditVerifyStatus(): AuditVerifyStatus | null {
  try {
    const v = JSON.parse(readFileSyncFs(auditStatusPath(), "utf-8")) as AuditVerifyStatus;
    return v && typeof v.state === "string" && typeof v.checkedAt === "string" ? v : null;
  } catch {
    return null;
  }
}

/**
 * Verifies the chain (edits, reorders, removed front records), the head receipt (removed newest records) and the override table
 * (edited or deleted rows), and stores the answer beside the store so a person can read it later. Never throws, never creates a store.
 */
export function runAuditVerifyNow(opts: { verifyChain?: typeof verifyAuditChainWithReceipt } = {}): AuditVerifyStatus {
  const checkedAt = new Date().toISOString();
  if (!storeExists()) return { state: "no_store", checkedAt, records: 0, receipt: "not_checked", problems: [], warnings: [] };
  const problems: string[] = [];
  const warnings: string[] = [];
  let records = 0;
  let receipt = "not_checked";
  try {
    const chain = (opts.verifyChain ?? verifyAuditChainWithReceipt)();
    records = chain.recordCount ?? 0;
    receipt = chain.receipt;
    if (!chain.valid) problems.push(`audit chain${chain.compromisedIndex !== undefined ? ` at record index ${chain.compromisedIndex}` : ""}: ${chain.reason ?? "verification failed"}`);
    else if (chain.receipt === "unreadable" && chain.reason) warnings.push(chain.reason);
    else if (chain.receipt === "absent" && records > 0) warnings.push("no head receipt yet: the end of the chain is not vouched for until the next record is written");
    const ov = verifyOverrideAudits();
    for (const p of ov.problems) problems.push(`override audit: ${p}`);
    if (ov.unchained > 0) warnings.push(`${ov.unchained} override row(s) have no matching chain record (written before overrides were chained, or added by hand)`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isDatabaseBusy(message)) return { state: "busy", checkedAt, records: 0, receipt: "not_checked", problems: [], warnings: ["the store was busy (another Purix process); the audit chain was not checked this time"] };
    problems.push(`the check could not run: ${message}`);
  }
  const status: AuditVerifyStatus = { state: problems.length > 0 ? "failed" : "ok", checkedAt, records, receipt, problems, warnings };
  try {
    writeJsonAtomic(auditStatusPath(), status);
  } catch {
    // The caller still gets the answer; only the stored copy is missing.
  }
  return status;
}

function reportAuditStatus(status: AuditVerifyStatus): void {
  if (status.state === "failed" || status.state === "busy") {
    console.error(status.state === "failed" ? `[scheduler] Audit verification FAILED: ${status.problems.join("; ")}` : `[scheduler] Audit verification skipped: ${status.warnings.join("; ")}.`);
  }
}

/** The install's export key: created once beside the user's other keys (never in the project), never a fixed default. */
function auditExportSecret(): string {
  const dir = userStateDir();
  const path = join(dir, "audit-export.key");
  const read = (): string | null => {
    try {
      const t = readFileSyncFs(path, "utf-8").trim();
      return /^[0-9a-f]{64}$/.test(t) ? t : null;
    } catch {
      return null;
    }
  };
  const existing = read();
  if (existing) return existing;
  mkdirSync(dir, { recursive: true });
  const fresh = randomBytes(32).toString("hex");
  if (createFileExclusive(path, `${fresh}\n`, { mode: 0o600 })) return fresh;
  return read() ?? (writeFileAtomic(path, `${fresh}\n`, { mode: 0o600 }), fresh);
}

export type AuditExportResult = { state: "written"; path: string; records: number } | { state: "no_store" } | { state: "failed"; reason: string };

/**
 * Writes the signed audit export beside the store. Until now exportAuditChainJson had no caller in the product. The signature uses
 * this install's key (the file `audit-export.key` in the user folder), which is what the export function requires; whoever
 * receives the file needs that key to check it, so a company that wants its own key calls exportAuditChainJson with it directly.
 */
export function runAuditExportNow(): AuditExportResult {
  if (!storeExists()) return { state: "no_store" };
  try {
    const text = exportAuditChainJson(auditExportSecret());
    const path = join(resolveSharedStateDir(), "audit-export.json");
    writeFileAtomic(path, text, { mode: 0o600 });
    return { state: "written", path, records: (JSON.parse(text) as { data: { records: unknown[] } }).data.records.length };
  } catch (err) {
    return { state: "failed", reason: err instanceof Error ? err.message : String(err) };
  }
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

/**
 * @param announce Whether to log the startup line. Defaults to `true` so
 * existing callers (the MCP server, the scheduler test worker) keep their
 * current behavior unchanged. Short-lived, one-shot CLI commands — which
 * call this once as part of routine setup and then exit almost
 * immediately, well before the first poll interval ever elapses — should
 * pass `false`: "Started, polling every 30000ms" is misleading noise for
 * a process that won't be alive in 30 seconds, and it printed on every
 * single mutating command invocation with no way to opt out.
 */
export function startScheduler(announce: boolean = true): void {
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

  if (announce) {
    console.error(`[scheduler] Started, polling every ${POLL_INTERVAL_MS}ms for due tasks`);
  }

  // A2a-1: check the audit chain once now. The hourly task never ran inside a short CLI command (the process is gone before the
  // first poll), so a broken chain was only ever noticed by the long-lived MCP server. Switch off with scheduler.verifyAtStart=false.
  if (getConfig().get("scheduler.verifyAtStart") !== false) reportAuditStatus(runAuditVerifyNow());
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
  () => reportAuditStatus(runAuditVerifyNow())
);

registerScheduledTask(
  "audit-chain-pruning",
  () => (getConfig().get("scheduler.auditPruneIntervalMs") as number) ?? 24 * 60 * 60 * 1000,
  () => {
    const maxAgeDays = (getConfig().get("scheduler.auditRetentionDays") as number) ?? 365;
    const olderThanMs = maxAgeDays * 24 * 60 * 60 * 1000;
    try {
      pruneAuditChain(olderThanMs);
    } catch (err) {
      console.error(`[scheduler] Audit chain pruning failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
);

// Research 15, finding 4: the events table and the model-call log had no limit. 365 days is the retention the audit chain already
// uses (research 08). No roll-up row is kept for removed rows (research 15 suggests one; not built). The budget and savings
// ledger are different tables and are not touched.
registerScheduledTask(
  "log-retention",
  () => (getConfig().get("scheduler.logPruneIntervalMs") as number) ?? 24 * 60 * 60 * 1000,
  () => {
    if (!storeExists()) return; // nothing recorded yet: do not create a database just to prune it
    const maxAgeDays = (getConfig().get("scheduler.logRetentionDays") as number) ?? 365;
    pruneEvents(maxAgeDays);
    pruneCallLog(maxAgeDays);
  }
);

registerScheduledTask(
  "audit-chain-export",
  () => (getConfig().get("scheduler.auditExportIntervalMs") as number) ?? 7 * 24 * 60 * 60 * 1000,
  () => {
    runAuditExportNow();
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