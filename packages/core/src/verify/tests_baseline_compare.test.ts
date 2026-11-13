// F06-02 (research 06 section 4): a failing test is judged against the unmodified code, not by re-running the changed code.
// Before: one re-run of the changed code forgave any failure whose re-run passed, so a test failing one run in two got through about
// 75 percent of the time (measured 72 percent of 60 runs). After: it is re-run on the unmodified code up to BASELINE_RUNS times; failed
// there too = not this change's doing (non-blocking, named); passed there every time = this change broke it (blocks).
//
// These run the repo's real tsx on tiny node:test projects, as tests_run.test.ts does. The "changed copy" is `dir`; the unmodified
// project is `base`. Counters are files outside both folders, so the number of runner starts can be read back.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb } from "../manifest/store";
import { runTestsWithQuarantine, BASELINE_RUNS } from "./tests";
import { makeVerificationCopy } from "../sandbox/sandbox.js";
import { resolveRealNodeModules } from "../test-support/real_node_modules";
import { safeRmSync } from "../platform/fs_retry.js";

const realModules = resolveRealNodeModules("tsx");
const skip = realModules ? false : "no node_modules with tsx found";

let cwd: string, dir: string, base: string, side: string;
let warn: typeof console.warn, log: typeof console.log, logs: string[];

function project(root: string, aValue: number): void {
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "p", type: "module", devDependencies: { "@types/node": "*" } }));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), `export const a = ${aValue};\n`);
  if (realModules && !existsSync(join(root, "node_modules"))) symlinkSync(realModules, join(root, "node_modules"), "junction");
}

beforeEach(() => {
  cwd = process.cwd();
  base = mkdtempSync(join(tmpdir(), "purix-base-"));
  dir = mkdtempSync(join(tmpdir(), "purix-changed-"));
  side = mkdtempSync(join(tmpdir(), "purix-side-"));
  project(base, 1); // the unmodified project: a = 1
  project(dir, 2); // the changed copy: a = 2
  process.chdir(dir);
  warn = console.warn; log = console.log; logs = [];
  console.warn = () => {};
  console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
});
afterEach(() => {
  console.warn = warn; console.log = log;
  closeDb();
  process.chdir(cwd);
  safeRmSync(dir); safeRmSync(base); safeRmSync(side);
});

const slash = (p: string) => p.replace(/\\/g, "/");
const header = `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { a } from "./a.ts";\nimport { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";\n`;
/** The test file goes into the changed copy and (unless told otherwise) the unmodified project too. */
function testFile(body: string, opts: { inBase?: boolean } = {}): string {
  const counter = slash(join(side, "starts.txt"));
  const text = `${header}appendFileSync("${counter}", "x");\n${body}\n`;
  writeFileSync(join(dir, "src", "a.test.ts"), text);
  if (opts.inBase !== false) writeFileSync(join(base, "src", "a.test.ts"), text);
  return counter;
}
const starts = (counter: string): number => (existsSync(counter) ? readFileSync(counter, "utf8").length : 0);
const baseline = () => makeVerificationCopy(base);

describe("baseline compare for a failing test (real tsx)", { skip }, () => {
  it("BLOCKS a test that passes on the unmodified code, and runs it there BASELINE_RUNS times", () => {
    const counter = testFile('test("a is one", () => { assert.equal(a, 1); });'); // a = 1 on base, 2 in the change
    const r = runTestsWithQuarantine("comp-regress", ["src/a.ts"], dir, { baseline });
    expect(r.status).toBe("fail");
    expect(r.reason).toContain("a is one");
    expect(r.reason).toContain("this change broke them");
    expect(r.preExistingFailures).toBeUndefined();
    expect(starts(counter)).toBe(1 + BASELINE_RUNS); // one run of the change, three of the unmodified code
  });

  it("BLOCKS the fail-once case that the old rule forgave (it passes on the unmodified code)", () => {
    const marker = slash(join(side, "seen.flag"));
    testFile(`test("flaky once", () => { if (!existsSync("${marker}")) { writeFileSync("${marker}", "x"); assert.fail("first time only"); } });`);
    // Old rule: the re-run of the changed code passes, so the failure was forgiven (tests_run.test.ts pins that rule when no baseline is offered).
    const withoutBaseline = runTestsWithQuarantine("comp-once-old", ["src/a.ts"], dir);
    expect(withoutBaseline.status).toBe("pass");
    // New rule: the same failure, judged against the unmodified code where it never fails, is the change's own.
    // (Rewriting the file resets the marker's role: remove the marker so the first run fails again.)
    safeRmSync(marker);
    const r = runTestsWithQuarantine("comp-once-new", ["src/a.ts"], dir, { baseline });
    expect(r.status).toBe("fail");
    expect(r.reason).toContain("flaky once");
  });

  it("does not block a test that fails on the unmodified code too, names it, and stops after the first baseline failure", () => {
    const counter = testFile('test("already broken", () => { assert.equal(1, 2); });');
    const r = runTestsWithQuarantine("comp-pre", ["src/a.ts"], dir, { baseline });
    expect(r.status).toBe("pass");
    expect(r.preExistingFailures).toEqual(["already broken"]);
    expect(starts(counter)).toBe(2); // the change, then one run of the unmodified code that already showed the failure
    expect(logs.join("\n")).toContain("failed on the unmodified code too");
  });

  it("a baseline that fails only on a later run still counts (flaky there)", () => {
    const n = slash(join(side, "calls.txt"));
    // calls: 1 = the change (fails), 2 = baseline round 1 (passes), 3 = baseline round 2 (fails)
    const counter = testFile(`test("flaky there", () => { appendFileSync("${n}", "x"); const k = readFileSync("${n}", "utf8").length; if (k === 1 || k === 3) assert.fail("call " + k); });`);
    const r = runTestsWithQuarantine("comp-flaky-base", ["src/a.ts"], dir, { baseline });
    expect(r.status).toBe("pass");
    expect(r.preExistingFailures).toEqual(["flaky there"]);
    expect(starts(counter)).toBe(3);
  });

  it("forgives nothing when the unmodified project cannot be copied, and says why", () => {
    testFile('test("broken", () => { assert.equal(1, 2); });');
    const r = runTestsWithQuarantine("comp-nocopy", ["src/a.ts"], dir, { baseline: () => { throw new Error("disk full"); } });
    expect(r.status).toBe("fail");
    expect(r.reason).toContain("could not be compared with the unmodified code");
    expect(r.reason).toContain("disk full");
    expect(r.reason).toContain("broken");
  });

  it("forgives nothing in a test file the change adds (it does not exist on the unmodified code)", () => {
    testFile('test("new and broken", () => { assert.equal(1, 2); });', { inBase: false });
    const r = runTestsWithQuarantine("comp-newfile", ["src/a.ts"], dir, { baseline });
    expect(r.status).toBe("fail");
    expect(r.reason).toContain("none of the selected test files exist on the unmodified code");
  });

  it("a passing run never makes a copy of the unmodified project", () => {
    testFile('test("fine", () => { assert.equal(a, 2); });');
    let copies = 0;
    const r = runTestsWithQuarantine("comp-nofail", ["src/a.ts"], dir, { baseline: () => { copies++; return makeVerificationCopy(base); } });
    expect(r.status).toBe("pass");
    expect(copies).toBe(0);
  });
});
