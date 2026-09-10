// packages/core/src/state/scheduler.test.ts
//
// Part 2 of the hot-reload prompt: state/scheduler.ts used to capture
// each task's interval ONCE at module-load time from whatever config
// held at that instant, and that captured value was then never even
// consulted by the tick loop — every registered task ran on every tick
// regardless of its configured interval (dead field, real bug). This
// file proves the fix: (a) in-process, deterministic tests of the
// due-check/live-config-read logic via the test-only __pollOnceForTests
// hook, and (b) one real end-to-end test — a genuinely separate, actually
// long-lived OS process (not the test process) whose behavior changes
// first process — since that's the literal scenario the prompt asked for
// ("a running Purix process ... pick up config/provider/entitlement
// changes without needing a restart").
import { describe, it, beforeEach, afterEach } from "node:test";

import { expect } from "expect";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfigStore } from "./config";
import { closeDb } from "../manifest/store";
import {
  registerScheduledTask,
  stopScheduler,
  __resetTaskScheduleForTests,
  __pollOnceForTests,
} from "./scheduler";
import { resolveTsxCommand } from "../test-support/real_node_modules";

const tsxCommand = resolveTsxCommand();
const workerPath = join(import.meta.dirname, "scheduler_process_worker.ts");

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function killProcessTree(child: Pick<ChildProcess, "pid" | "kill">): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {}
  }
}

describe("scheduler lifecycle tests", { concurrency: false }, () => {
describe("Part 2: scheduler live interval + enable/disable (in-process, deterministic)", { concurrency: false }, () => {
  let dir: string;
  let oldCwd: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "purix-scheduler-test-"));
    oldCwd = process.cwd();
    process.chdir(dir);
    __resetTaskScheduleForTests();
  });

  afterEach(() => {
    stopScheduler();
    closeDb();
    process.chdir(oldCwd);
    rmSync(dir, { recursive: true, force: true });
    delete process.env.PURIX_SCHEDULER_POLL_MS;
  });

  it("a task only runs once its OWN configured interval has elapsed, not on every poll", async () => {
    const config = createConfigStore(dir);
    config.set("test.everyPollIntervalMs", 1);
    let runs = 0;
    registerScheduledTask("every-poll", () => config.get("test.everyPollIntervalMs") as number, () => runs++);

    // First poll: lastRunAt starts at 0, so this is always "due" — that's
    // intentional (run once promptly at startup), matches the assertion
    // below of exactly one run per poll when the interval is effectively 0.
    __pollOnceForTests();
    expect(runs).toBe(1);

    // A real (tiny) delay so Date.now() has actually advanced past the
    // 1ms configured interval — two __pollOnceForTests() calls back to
    // back with zero elapsed wall-clock time would otherwise both land in
    // the same millisecond and the second wouldn't be "due" yet, which
    // would be a timing artifact of this test, not a real bug.
    await sleep(5);
    __pollOnceForTests();
    expect(runs).toBe(2);
  });

  it("raising a task's configured interval via config.set is honored on the VERY NEXT poll — no re-registration needed", () => {
    const config = createConfigStore(dir);
    config.set("test.intervalMs", 1);
    let runs = 0;
    registerScheduledTask("reconfigurable", () => config.get("test.intervalMs") as number, () => runs++);

    __pollOnceForTests();
    expect(runs).toBe(1);

    // Simulates `purix config set test.intervalMs 100000` from another
    // invocation — this task's getIntervalMs() closure reads the SAME
    // config store fresh each time, so this takes effect without ever
    // calling registerScheduledTask again.
    config.set("test.intervalMs", 100_000);
    __pollOnceForTests();
    __pollOnceForTests();
    __pollOnceForTests();
    expect(runs).toBe(1); // still 1 — correctly not due again for a long time
  });

  it("scheduler.enabled=false stops ALL tasks' next run live, and re-enabling resumes without restart", () => {
    const config = createConfigStore(dir);
    let runs = 0;
    registerScheduledTask("gated-task", () => 1, () => runs++);

    __pollOnceForTests();
    expect(runs).toBe(1);

    config.set("scheduler.enabled", false);
    __pollOnceForTests();
    __pollOnceForTests();
    expect(runs).toBe(1); // no new runs while disabled

    config.set("scheduler.enabled", true);
    __pollOnceForTests();
    expect(runs).toBe(2); // resumes on the very next poll, no restart
  });

  it("an interval of 0 (or less) disables that specific task without affecting others", async () => {
    let aRuns = 0;
    let bRuns = 0;
    registerScheduledTask("task-a", () => 0, () => aRuns++);
    registerScheduledTask("task-b", () => 1, () => bRuns++);

    __pollOnceForTests();
    await sleep(5);
    __pollOnceForTests();
    expect(aRuns).toBe(0);
    expect(bRuns).toBe(2);
  });
});

describe("Part 2: scheduler hot reload — real end-to-end across processes", { concurrency: false }, () => {
  let dir: string;
  let logPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "purix-scheduler-e2e-"));
    mkdirSync(join(dir, ".purix"), { recursive: true });
    logPath = join(dir, "ticks.log");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function countTicks(): number {
    if (!existsSync(logPath)) return 0;
    return readFileSync(logPath, "utf8").split("\n").filter(Boolean).length;
  }

  function writeConfigFromSeparateProcess(key: string, value: string): Promise<void> {
    return new Promise((resolvePromise, reject) => {
      const commandParts = [...tsxCommand, join(import.meta.dirname, "config_write_once_worker.ts"), dir, key, value];
      const [command, ...args] = commandParts;
      if (!command) throw new Error("empty spawn command");
      const child = spawn(
        command,
        args,
        { cwd: dir, stdio: ["ignore", "pipe", "pipe"] }
      );
      let stderr = "";
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      child.on("exit", (code: number | null) => (code === 0 ? resolvePromise() : reject(new Error(stderr))));
    });
  }

  it("a real long-lived process picks up a task-interval change AND a live disable from other processes, with no restart", async () => {
    // Fast polling so this test finishes in well under a second of real
    // time instead of needing production's 30s cadence — see
    // PURIX_SCHEDULER_POLL_MS's doc comment in scheduler.ts.
    const commandParts = [...tsxCommand, workerPath, dir, "15000", logPath];
    const [command, ...args] = commandParts;
    if (!command) throw new Error("empty spawn command");
    const worker = spawn(command, args, {
      env: { ...process.env, PURIX_SCHEDULER_POLL_MS: "20" },
      cwd: dir,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let workerStderr = "";
    worker.stderr!.on("data", (d: Buffer) => (workerStderr += d.toString()));
    const workerPid = worker.pid;

    try {
      // Phase 1: worker's test-task defaults to a 100s interval (see
      // scheduler_process_worker.ts) — it fires once immediately at
      // startup (lastRunAt starts at 0) and then should NOT fire again
      // within this short window on its own. Polling repeatedly instead
      // of one fixed sleep, since tsx's own cold-start time (module
      // resolution + esbuild transform) is itself variable — this test
      // cares about eventual behavior, not startup latency.
      let afterStartup = 0;
      for (let i = 0; i < 120; i++) {
        afterStartup = countTicks();
        if (afterStartup >= 1) break;
        await sleep(50);
      }
      expect(afterStartup).toBeGreaterThanOrEqual(1);
      // Phase 2: a SEPARATE, short-lived process rewrites the SAME
      // config file to make the task fire every 15ms. The worker started
      // above is never touched — same PID, same process, the whole time.
      await writeConfigFromSeparateProcess("test.taskIntervalMs", "15");
      expect(worker.exitCode).toBeNull(); // still the original process, not restarted
      expect(worker.pid).toBe(workerPid);

      await sleep(600);
      const afterFastInterval = countTicks();
      if (afterFastInterval <= afterStartup + 3) {
        throw new Error(`worker exit=${worker.exitCode}; stderr=${workerStderr}; startup=${afterStartup}; fast=${afterFastInterval}`);
      }

      // Phase 3: another separate process live-disables the scheduler
      // entirely. Confirm the SAME long-lived process stops ticking.
      await writeConfigFromSeparateProcess("scheduler.enabled", "false");
      const atDisable = countTicks();
      await sleep(400);
      const afterDisable = countTicks();
      expect(afterDisable).toBe(atDisable); // no further ticks once disabled, no restart involved
    } finally {
      if (worker.exitCode === null) killProcessTree(worker);
      await new Promise<void>((r) => worker.on("exit", () => r()));
    }
  });
});
});