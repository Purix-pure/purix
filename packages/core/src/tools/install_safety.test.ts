// src/tools/install_safety.test.ts
//
// A10b-1 (research 12 findings 1 and 7, D15): installs must not lose each other's records, two installs of one tool must not
// run side by side, and an install that hits its deadline must be reported as a timeout, not as "npm was not found".
import { describe, it } from "node:test";
import { expect } from "expect";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { installTool } from "./broker.js";
import { defaultRunner, installEntry, type RunResult, type Runner } from "./installer.js";
import { acquireInstallLock, installLockPath, readLock, recordPath, removeRecord, toolsDir, writeLock, writeRecord } from "./state.js";
import { fakeRunner, memoryAudit, npmEntry, pipEntry, tempProject } from "./test_helpers.js";
import type { LockRecord } from "./types.js";

const NOW = new Date("2026-11-01T00:00:00Z");
const posix = process.platform !== "win32";
const slowYes = (ms: number) => ({ confirmInstall: async () => { await new Promise((r) => setTimeout(r, ms)); return true; } });
const A = npmEntry({ id: "demojs", bin: "demojs" });
const B = npmEntry({ id: "otherjs", bin: "demojs" });
const rec = (id: string): LockRecord => ({ id, package: id, version: "1.0.0", method: "npm-ci", lockSha256: "a".repeat(64), installedAt: NOW.toISOString(), binRelPath: "node_modules/.bin/x" });
const ids = (dir: string): string[] => { const l = readLock(dir); return l.kind === "ok" ? l.lock.records.map((r) => r.id).sort() : ["CORRUPT"]; };

describe("two installs of different tools both stay recorded", () => {
  it("in one process, with a slow human prompt in between (was: only the last writer survived)", async () => {
    const p = tempProject();
    try {
      const deps = () => ({ baseDir: p.dir, catalog: [A, B], platform: "linux" as const, runner: fakeRunner(), audit: memoryAudit(), consent: slowYes(60), now: () => NOW });
      const [r1, r2] = await Promise.all([installTool(deps(), "demojs"), installTool(deps(), "otherjs")]);
      expect([r1.ok, r2.ok]).toEqual([true, true]);
      expect(ids(p.dir)).toEqual(["demojs", "otherjs"]);
    } finally { p.cleanup(); }
  });

  it("in two processes started together", async () => {
    const p = tempProject();
    try {
      const child = fileURLToPath(new URL("./install_safety_child.ts", import.meta.url));
      const run = (id: string) => new Promise<{ ok: boolean; reason?: string }>((resolve, reject) => {
        const outFile = join(p.dir, `${id}.result.json`);
        const c = spawn(process.execPath, ["--import", "tsx", child, p.dir, id, "400", outFile], { stdio: "ignore" });
        c.on("error", reject);
        c.on("close", () => { try { resolve(JSON.parse(readFileSync(outFile, "utf-8")) as { ok: boolean; reason?: string }); } catch { reject(new Error(`child ${id} left no result`)); } });
      });
      const [x, y] = await Promise.all([run("demojs"), run("otherjs")]);
      expect(x.ok).toBe(true);
      expect(y.ok).toBe(true);
      expect(ids(p.dir)).toEqual(["demojs", "otherjs"]);
    } finally { p.cleanup(); }
  });
});

describe("records", () => {
  it("one file per tool; a tool recorded in an old lock.json is still read, and a record file wins over it", () => {
    const p = tempProject();
    try {
      writeLock(p.dir, { version: 1, records: [rec("old"), { ...rec("both"), version: "0.0.1" }] });
      writeRecord(p.dir, { ...rec("both"), version: "2.0.0" });
      writeRecord(p.dir, rec("fresh"));
      const l = readLock(p.dir);
      expect(l.kind).toBe("ok");
      if (l.kind === "ok") expect(l.lock.records.map((r) => `${r.id}@${r.version}`)).toEqual(["both@2.0.0", "fresh@1.0.0", "old@1.0.0"]);
    } finally { p.cleanup(); }
  });
  it("removeRecord drops the record file and the same id from an old lock.json, leaving the others", () => {
    const p = tempProject();
    try {
      writeLock(p.dir, { version: 1, records: [rec("old"), rec("keep")] });
      writeRecord(p.dir, rec("fresh"));
      removeRecord(p.dir, "fresh");
      removeRecord(p.dir, "old");
      expect(ids(p.dir)).toEqual(["keep"]);
      expect(existsSync(recordPath(p.dir, "fresh"))).toBe(false);
    } finally { p.cleanup(); }
  });
  it("a damaged record file makes the state corrupt and names the file", () => {
    const p = tempProject();
    try {
      writeRecord(p.dir, rec("fresh"));
      writeFileSync(recordPath(p.dir, "fresh"), "{not json");
      const l = readLock(p.dir);
      expect(l.kind).toBe("corrupt");
      if (l.kind === "corrupt") expect(l.error).toContain("fresh.json");
    } finally { p.cleanup(); }
  });
  it("refuses a tool id that could leave the records folder", () => {
    const p = tempProject();
    try {
      expect(() => recordPath(p.dir, "../x")).toThrow();
      expect(() => recordPath(p.dir, "a/b")).toThrow();
    } finally { p.cleanup(); }
  });
});

describe("the per-tool install lock", () => {
  it("a second installer of the same tool is refused while the first is running, and the lock is released after", async () => {
    const p = tempProject();
    try {
      const held = acquireInstallLock(p.dir, "demojs", { now: NOW });
      expect(held.ok).toBe(true);
      const calls: string[][] = [];
      const runner = fakeRunner(); const spy: Runner = { run: (argv, o) => { calls.push(argv); return runner.run(argv, o); } };
      const r = await installTool({ baseDir: p.dir, catalog: [A], platform: "linux", runner: spy, audit: memoryAudit(), consent: slowYes(1), now: () => NOW }, "demojs");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("install-in-progress");
      expect(calls).toEqual([]);
      if (held.ok) held.release();
      const again = await installTool({ baseDir: p.dir, catalog: [A], platform: "linux", runner: fakeRunner(), audit: memoryAudit(), consent: slowYes(1), now: () => NOW }, "demojs");
      expect(again.ok).toBe(true);
      expect(existsSync(installLockPath(p.dir, "demojs"))).toBe(false);
    } finally { p.cleanup(); }
  });
  it("a lock left by a process that is gone, or one older than its limit, does not block forever", () => {
    const p = tempProject();
    try {
      mkdirSync(toolsDir(p.dir), { recursive: true });
      writeFileSync(installLockPath(p.dir, "demojs"), JSON.stringify({ pid: 2 ** 22 + 12345, startedAt: NOW.toISOString() }));
      const a = acquireInstallLock(p.dir, "demojs", { now: NOW });
      expect(a.ok).toBe(true);
      if (a.ok) a.release();
      writeFileSync(installLockPath(p.dir, "demojs"), JSON.stringify({ pid: process.pid, startedAt: "2026-10-31T00:00:00.000Z" }));
      const b = acquireInstallLock(p.dir, "demojs", { now: NOW, staleMs: 60_000 });
      expect(b.ok).toBe(true);
      if (b.ok) b.release();
    } finally { p.cleanup(); }
  });
  it("an unreadable lock file is treated as held by someone, not deleted", () => {
    const p = tempProject();
    try {
      mkdirSync(toolsDir(p.dir), { recursive: true });
      writeFileSync(installLockPath(p.dir, "demojs"), "garbage");
      const a = acquireInstallLock(p.dir, "demojs", { now: NOW });
      expect(a.ok).toBe(false);
      expect(existsSync(installLockPath(p.dir, "demojs"))).toBe(true);
    } finally { p.cleanup(); }
  });
});

describe("an install that is stopped is not 'npm was not found'", () => {
  const stoppedRunner = (stopped: RunResult["stopped"]): Runner => ({ run: () => ({ exitCode: null, stdout: "", stderr: "", ...(stopped ? { stopped } : {}) }) });
  const ctx = (dir: string, runner: Runner) => ({ baseDir: dir, platform: "linux" as const, now: NOW, runner, minReleaseAgeDays: 7 });

  it("timeout -> install-timeout", () => {
    const p = tempProject();
    try {
      const o = installEntry(A, ctx(p.dir, stoppedRunner("timeout")));
      expect(o.ok).toBe(false);
      if (!o.ok) { expect(o.reason).toBe("install-timeout"); expect(o.message).not.toContain("not found"); }
    } finally { p.cleanup(); }
  });
  it("output over the cap or machine out of resources -> install-limit", () => {
    const p = tempProject();
    try {
      for (const s of ["output_limit", "resource_limit"] as const) {
        const o = installEntry(A, ctx(p.dir, stoppedRunner(s)));
        expect(!o.ok && o.reason).toBe("install-limit");
      }
    } finally { p.cleanup(); }
  });
  it("a command that could not be found stays runtime-missing, with or without the stopped field", () => {
    const p = tempProject();
    try {
      expect((installEntry(A, ctx(p.dir, stoppedRunner("not_found"))) as { reason: string }).reason).toBe("runtime-missing");
      expect((installEntry(A, ctx(p.dir, stoppedRunner(undefined))) as { reason: string }).reason).toBe("runtime-missing");
    } finally { p.cleanup(); }
  });
  it("a timeout while creating the Python venv is a timeout, not 'command-failed' or 'Python not found'", () => {
    const p = tempProject();
    try {
      const calls: string[] = [];
      const runner: Runner = { run: (argv) => { calls.push(argv.join(" ")); return argv[1] === "--version" ? { exitCode: 0, stdout: "", stderr: "" } : { exitCode: null, stdout: "", stderr: "", stopped: "timeout" }; } };
      const o = installEntry(pipEntry(), ctx(p.dir, runner));
      expect(!o.ok && o.reason).toBe("install-timeout");
    } finally { p.cleanup(); }
  });
  it("the broker passes it on, writes no record, and audits the failure", async () => {
    const p = tempProject();
    try {
      const audit = memoryAudit();
      const r = await installTool({ baseDir: p.dir, catalog: [A], platform: "linux", runner: stoppedRunner("timeout"), audit, consent: slowYes(1), now: () => NOW }, "demojs");
      expect(!r.ok && r.reason).toBe("install-timeout");
      expect(ids(p.dir)).toEqual([]);
      expect(audit.events.map((e) => e.action)).toEqual(["approval", "install_failed"]);
      expect(existsSync(installLockPath(p.dir, "demojs"))).toBe(false);
    } finally { p.cleanup(); }
  });
});

describe("the real runner", { skip: !posix }, () => {
  it("hands the deadline to the child and reports `stopped`", () => {
    const p = tempProject();
    try {
      const r = defaultRunner.run(["sleep", "5"], { cwd: p.dir, deadlineMs: 200 });
      expect(r.exitCode).toBeNull();
      expect(r.stopped).toBe("timeout");
    } finally { p.cleanup(); }
  });
  it("a hung `npm ci` ends at the install deadline and says so", async () => {
    const p = tempProject();
    const bin = mkdtempSync(join(tmpdir(), "purix-fake-npm-"));
    const oldPath = process.env.PATH;
    try {
      writeFileSync(join(bin, "npm"), "#!/bin/sh\nsleep 30\n");
      chmodSync(join(bin, "npm"), 0o755);
      process.env.PATH = `${bin}:${oldPath}`;
      const t0 = Date.now();
      const r = await installTool({ baseDir: p.dir, catalog: [A], platform: "linux", audit: memoryAudit(), consent: slowYes(1), now: () => NOW, installDeadlineMs: 400 }, "demojs");
      expect(Date.now() - t0).toBeLessThan(5_000);
      expect(!r.ok && r.reason).toBe("install-timeout");
      expect(ids(p.dir)).toEqual([]);
    } finally { process.env.PATH = oldPath; p.cleanup(); }
  });
});
