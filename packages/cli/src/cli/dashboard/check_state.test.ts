// The `purix check` state on a project card: the report is read strictly, a page never waits for a run, only two run at once, and a
// failed or slow run reads "could not be checked", never clean.
import { describe, it } from "node:test";
import { expect } from "expect";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loaderArgs, cardCheckWords, createCheckStateProvider, parseCheckReport, resolveCliEntry, spawnCheckRunner, type CheckRunner } from "./check_state.js";

const report = (outcome: string, summary = "all good") => JSON.stringify({ schema: 1, outcome, summary });
const flush = () => new Promise<void>((r) => setImmediate(r));

describe("parseCheckReport", () => {
  it("reads schema 1 with a known outcome and a summary", () => {
    expect(parseCheckReport(report("pass"))).toEqual({ outcome: "pass", summary: "all good" });
  });
  it("refuses anything else instead of guessing", () => {
    expect(parseCheckReport("not json")).toHaveProperty("error");
    expect(parseCheckReport(JSON.stringify({ schema: 2, outcome: "pass", summary: "x" }))).toHaveProperty("error");
    expect(parseCheckReport(JSON.stringify({ schema: 1, outcome: "great", summary: "x" }))).toHaveProperty("error");
    expect(parseCheckReport(JSON.stringify({ schema: 1, outcome: "pass" }))).toHaveProperty("error");
    expect(parseCheckReport("null")).toHaveProperty("error");
  });
});

describe("createCheckStateProvider", () => {
  it("answers 'checking' at once and the real state on a later call", async () => {
    const p = createCheckStateProvider({ run: async () => ({ stdout: report("fail", "1 file drifted") }) });
    expect(p.get("/a").kind).toBe("checking");
    expect(p.anyChecking()).toBe(true);
    await flush();
    const s = p.get("/a");
    expect(s).toMatchObject({ kind: "done", outcome: "fail", summary: "1 file drifted" });
    expect(p.anyChecking()).toBe(false);
  });

  it("reuses an answer inside its time and runs again after it, showing the old answer meanwhile", async () => {
    let t = 0, runs = 0, release: (() => void) | undefined;
    const run: CheckRunner = () => { runs++; return runs === 1 ? Promise.resolve({ stdout: report("pass") }) : new Promise((res) => { release = () => res({ stdout: report("fail", "later") }); }); };
    const p = createCheckStateProvider({ run, now: () => t, ttlMs: 1000 });
    p.get("/a"); await flush();
    t = 500; p.get("/a"); expect(runs).toBe(1);
    t = 2000;
    const during = p.get("/a");
    expect(runs).toBe(2);
    expect(during).toMatchObject({ kind: "done", outcome: "pass", refreshing: true });
    release!(); await flush();
    expect(p.get("/a")).toMatchObject({ outcome: "fail", summary: "later" });
  });

  it("runs at most two at a time", async () => {
    let active = 0, peak = 0;
    const releases: (() => void)[] = [];
    const run: CheckRunner = () => { active++; peak = Math.max(peak, active); return new Promise((res) => { releases.push(() => { active--; res({ stdout: report("pass") }); }); }); };
    const p = createCheckStateProvider({ run });
    for (const n of ["/1", "/2", "/3", "/4"]) p.get(n);
    expect(peak).toBe(2);
    while (releases.length) { releases.shift()!(); await flush(); }
    expect(peak).toBe(2);
    expect(p.get("/4").kind).toBe("done");
  });

  it("a runner that fails or throws is 'unavailable', never clean", async () => {
    const p = createCheckStateProvider({ run: async (path) => { if (path === "/throws") throw new Error("boom"); return { error: "took too long" }; } });
    p.get("/slow"); p.get("/throws"); await flush();
    expect(p.get("/slow")).toMatchObject({ kind: "unavailable", why: "took too long" });
    expect(p.get("/throws")).toMatchObject({ kind: "unavailable", why: "boom" });
  });
});

describe("cardCheckWords", () => {
  it("says clean only for a pass, and flags problems", () => {
    expect(cardCheckWords({ kind: "done", outcome: "pass", summary: "s", at: 0, refreshing: false }).label).toBe("clean");
    const bad = cardCheckWords({ kind: "done", outcome: "fail", summary: "s", at: 0, refreshing: false });
    expect(bad.label).toBe("problem found");
    expect(bad.attention).toBe(true);
    expect(cardCheckWords({ kind: "done", outcome: "skipped", summary: "never synced", at: 0, refreshing: false }).label).toBe("not fully verified");
    expect(cardCheckWords({ kind: "unavailable", why: "x", at: 0, refreshing: false }).label).toBe("could not be checked");
    expect(cardCheckWords({ kind: "checking" }).label).toBe("checking");
  });
});

describe("resolveCliEntry", () => {
  it("finds the CLI from where the module lives, whatever argv[1] says", () => {
    const viaWrapper = resolveCliEntry("/usr/lib/some-wrapper/shim.js");
    expect(viaWrapper.entry).toMatch(/[\\/]cli\.(js|ts)$/);
    expect(viaWrapper.entry).not.toContain("shim.js");
    expect(existsSync(viaWrapper.entry)).toBe(true);
  });
  it("falls back to argv[1] only when no CLI file sits where this module expects it", () => {
    // A real absolute path on any OS (a bare file:///nowhere/... has no drive letter and Windows refuses it), in an empty folder, so no cli file is found.
    const empty = mkdtempSync(join(tmpdir(), "check-entry-none-"));
    try {
      const here = pathToFileURL(join(empty, "a", "b", "c.js")).href;
      expect(resolveCliEntry("/x/y/cli.js", here)).toEqual({ entry: "/x/y/cli.js", execArgv: [] });
    } finally { rmSync(empty, { recursive: true, force: true }); }
  });
  it("the resolved entry really answers `check --json --no-register` in a folder that is not a Purix project, with a wrapper as argv[1]", async () => {
    const dir = mkdtempSync(join(tmpdir(), "check-entry-"));
    try {
      const cli = resolveCliEntry("/usr/lib/some-wrapper/shim.js");
      const res = await spawnCheckRunner(cli.entry, 60_000, cli.execArgv)(dir);
      // Either a report, or a plain "could not run" -- but the run must not have failed for want of a CLI file. A report parses.
      if ("stdout" in res) expect(parseCheckReport(res.stdout)).toHaveProperty("outcome");
      else expect(res.error).not.toMatch(/Cannot find module/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("loaderArgs", () => {
  it("keeps loader flags that mean the same in another folder, and drops relative ones", () => {
    expect(loaderArgs(["--require", "/a/pre.cjs", "--import", "file:///a/l.mjs", "--import", "./scripts/x.mjs", "--inspect", "-r", "C:\\x\\y.cjs"]))
      .toEqual(["--require", "/a/pre.cjs", "--import", "file:///a/l.mjs", "-r", "C:\\x\\y.cjs"]);
    expect(loaderArgs([])).toEqual([]);
  });
});