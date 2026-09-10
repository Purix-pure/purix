// packages/core/src/state/scheduler_process_worker.ts
//
// Standin for the one genuinely long-lived process in this codebase (the
// MCP server) that registers scheduler tasks once at startup and must
// then pick up config changes made by OTHER processes/invocations for the
// rest of its life, without restarting. Stays alive for a fixed duration
// so the parent test can make config changes partway through and observe
// the effect on THIS SAME process/PID.
import { appendFileSync, existsSync } from "node:fs";
import { createConfigStore } from "./config.js";
import { registerScheduledTask, startScheduler } from "./scheduler.js";

const baseDir = process.argv[2];
const totalDurationMs = Number(process.argv[3]);
const logPath = process.argv[4];

if (!baseDir || !totalDurationMs || !logPath) {
  console.error("usage: scheduler_process_worker.ts <baseDir> <totalDurationMs> <logPath>");
  process.exit(1);
}

process.chdir(baseDir);
const config = createConfigStore(baseDir);

registerScheduledTask(
  "test-task",
  // Deliberately a large default (never due within this test's window) so
  // the test can prove a small explicit config value, written by a LATER,
  // separate process, is what actually makes it start firing.
  () => (config.get("test.taskIntervalMs") as number) ?? 100_000,
  () => appendFileSync(logPath, `${Date.now()}\n`)
);

startScheduler();

// process.exitCode + a plain timeout (not unref'd) keeps this process
// alive for exactly the window the test needs, then it exits on its own —
// the test never has to guess when it's "safe" to kill it or race a kill
// signal against in-flight file writes.
setTimeout(() => process.exit(0), totalDurationMs);

if (!existsSync(baseDir)) {
  console.error(`baseDir vanished: ${baseDir}`);
  process.exit(1);
}
