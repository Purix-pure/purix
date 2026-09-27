// packages/core/src/state/scheduler_process_worker.ts
//
// Standalone entry point spawned as a real, long-lived child process by
// scheduler.test.ts's "real end-to-end across processes" hot-reload test.
//
// NOTE (2026-09-24): this file previously held a byte-for-byte copy of
// project_id_race_worker.ts (a wrong-file paste). That copy called
// getProjectId() and exited 0 immediately, never starting a scheduler, so
// the hot-reload test could never pass. This is the real worker.
//
// Usage: scheduler_process_worker.ts <baseDir> <lifetimeMs> <logPath>
//   - chdir(baseDir): the scheduler reads config from process.cwd().
//   - registers one task whose interval is read LIVE from the config key
//     "test.taskIntervalMs" (default 100s, i.e. it fires once at startup
//     because lastRunAt starts at 0, then not again on its own).
//   - each run appends one line to <logPath>, which the parent counts.
//   - stays alive for <lifetimeMs> (the scheduler's own timer is unref'd,
//     so without this the process would exit immediately), then exits.
import { appendFileSync, writeSync } from "node:fs";
import { createConfigStore } from "./config.js";
import { registerScheduledTask, startScheduler, stopScheduler } from "./scheduler.js";

const baseDir = process.argv[2];
const lifetimeMs = Number(process.argv[3]);
const logPath = process.argv[4];
if (!baseDir || !Number.isFinite(lifetimeMs) || lifetimeMs <= 0 || !logPath) {
  writeSync(2, "usage: scheduler_process_worker.ts <baseDir> <lifetimeMs> <logPath>\n");
  process.exit(1);
}

process.chdir(baseDir);

const DEFAULT_TASK_INTERVAL_MS = 100_000;
registerScheduledTask(
  "e2e-hot-reload-probe",
  () => {
    const v = createConfigStore(baseDir).get("test.taskIntervalMs");
    return typeof v === "number" ? v : DEFAULT_TASK_INTERVAL_MS;
  },
  () => appendFileSync(logPath, `${Date.now()}\n`)
);

startScheduler(false);

// Ref'd timer keeps this process alive for the test's window.
setTimeout(() => {
  stopScheduler();
  process.exit(0);
}, lifetimeMs);