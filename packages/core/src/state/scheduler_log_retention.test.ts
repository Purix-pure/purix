// Research 15, finding 4: the scheduler runs the log-retention task.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeRmSync } from "../platform/fs_retry.js";
import { closeDb, getDbCompat } from "../manifest/store.js";
import { listEvents, recordEvent } from "../manifest/events.js";
import { __pollOnceForTests, __resetTaskScheduleForTests, startScheduler, stopScheduler } from "./scheduler.js";

describe("scheduled log retention", () => {
  let cwd: string, dir: string, userDir: string, saved: string | undefined;
  beforeEach(() => {
    cwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), "purix-sched-ret-"));
    userDir = mkdtempSync(join(tmpdir(), "purix-sched-ret-user-"));
    saved = process.env.PURIX_USER_DIR;
    process.env.PURIX_USER_DIR = userDir;
    process.chdir(dir);
  });
  afterEach(() => {
    stopScheduler(); closeDb(); process.chdir(cwd);
    if (saved === undefined) delete process.env.PURIX_USER_DIR; else process.env.PURIX_USER_DIR = saved;
    safeRmSync(dir); safeRmSync(userDir);
  });

  it("removes year-old events when due and keeps recent ones", () => {
    recordEvent("request", { component_id: "recent" });
    getDbCompat().run(`INSERT INTO events (id, timestamp, kind, component_id, operation, detail) VALUES ('ancient', ?, 'request', 'x', 'op', '{}')`, [
      new Date(Date.now() - 400 * 86_400_000).toISOString(),
    ]);
    startScheduler(false);
    __resetTaskScheduleForTests();
    __pollOnceForTests();
    const ids = listEvents().map((e) => e.component_id);
    expect(ids).toContain("recent");
    expect(ids).not.toContain("x");
  });
});
