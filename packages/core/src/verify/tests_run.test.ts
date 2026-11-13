// runTestsWithQuarantine() end to end, with the repo's real tsx running tiny node:test projects: pass, no tests,
// consistent failure (re-run still fails), flaky failure (re-run passes) and unparseable output.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb } from "../manifest/store";
import { runTestsWithQuarantine } from "./tests";
import { recordTestResult } from "../manifest/test_history.js";
import { resolveRealNodeModules } from "../test-support/real_node_modules";
import { safeRmSync } from "../platform/fs_retry.js";

const realModules = resolveRealNodeModules("tsx");
const skip = realModules ? false : "no node_modules with tsx found";

let cwd: string;
let dir: string;
let warn: typeof console.warn;
let log: typeof console.log;

beforeEach(() => {
  cwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "purix-run-"));
  process.chdir(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "p", type: "module", devDependencies: { "@types/node": "*" } }));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
  if (realModules) symlinkSync(realModules, join(dir, "node_modules"), "junction");
  warn = console.warn;
  log = console.log;
  console.warn = () => {};
  console.log = () => {};
});
afterEach(() => {
  console.warn = warn;
  console.log = log;
  // LIFECYCLE FIX: this test spawns the repo's real tsx child process for
  // each case and closes the manifest DB right before deleting `dir` — the
  // same closeDb()/just-exited-child Windows EPERM race documented in
  // budget_edges.test.ts. safeRmSync retries with backoff instead of
  // failing the whole test on a transient file-lock.
  closeDb();
  process.chdir(cwd);
  safeRmSync(dir);
});

const testFile = (body: string) => writeFileSync(join(dir, "src", "a.test.ts"), `import { test } from "node:test";\nimport assert from "node:assert/strict";\n${body}\n`);

describe("runTestsWithQuarantine (real tsx)", { skip }, () => {
  it("passes when every test passes", () => {
    testFile('test("adds", () => { assert.equal(1 + 1, 2); });');
    const r = runTestsWithQuarantine("comp-pass", ["src/a.ts"], dir);
    expect(r.status).toBe("pass");
    expect(r.quarantinedFailures).toEqual([]);
  });
  it("reports no_tests when no related test exists", () => {
    expect(runTestsWithQuarantine("comp-none", ["src/a.ts"], dir).status).toBe("no_tests");
  });
  it("fails a test that fails again on the re-run, naming it", () => {
    testFile('test("always broken", () => { assert.equal(1, 2); });');
    const r = runTestsWithQuarantine("comp-fail", ["src/a.ts"], dir);
    expect(r.status).toBe("fail");
    expect(r.reason).toContain("always broken");
  });
  it("does not block on a first-time failure that does not reproduce on the re-run", () => {
    const marker = join(dir, "seen.flag").replace(/\\/g, "/");
    testFile(`import { existsSync, writeFileSync } from "node:fs";\ntest("flaky once", () => { if (!existsSync("${marker}")) { writeFileSync("${marker}", "x"); assert.fail("first time only"); } });`);
    const r = runTestsWithQuarantine("comp-flaky", ["src/a.ts"], dir);
    expect(r.status).toBe("pass");
  });
  it("fails with the runner's output when nothing parseable comes back and the exit code is non-zero", () => {
    testFile("this is not valid typescript )(");
    const r = runTestsWithQuarantine("comp-syntax", ["src/a.ts"], dir);
    expect(r.status).toBe("fail");
    expect((r.reason ?? "").length).toBeGreaterThan(0);
  });
  // A6-1 (research 06, ADR-069 count rule): a run that exercised nothing is NOT TESTED, whatever the exit code said. It used to
  // be "pass" (this test asserted that). "no_tests" is the status every consumer already reads as "not tested, not a pass,
  // not worth a repair"; the changed source files travel in discovery.uncovered, which sandbox.ts turns into the Not-Tested trailer.
  it("is NOT TESTED, not a pass, when the test file runs cleanly but declares no tests", () => {
    testFile("const unused = 1; void unused;");
    const r = runTestsWithQuarantine("comp-empty", ["src/a.ts"], dir);
    expect(r.status).toBe("no_tests");
    expect(r.notRun).toBe("no_tests_ran");
    expect(r.discovery?.uncovered).toEqual(["src/a.ts"]);
    expect(r.reason).toMatch(/no test ran/i);
  });
  it("is NOT TESTED when every test is skipped", () => {
    testFile('test("never runs", { skip: true }, () => { assert.equal(1, 2); });');
    const r = runTestsWithQuarantine("comp-allskip", ["src/a.ts"], dir);
    expect(r.status).toBe("no_tests");
    expect(r.notRun).toBe("all_skipped");
    expect(r.counts).toEqual({ passed: 0, failed: 0, skipped: 1 });
    expect(r.discovery?.uncovered).toEqual(["src/a.ts"]);
  });
  it("is NOT TESTED when the only entries are todo", () => {
    testFile('test.todo("later");');
    const r = runTestsWithQuarantine("comp-todo", ["src/a.ts"], dir);
    expect(r.status).toBe("no_tests");
    expect(r.notRun).toBe("all_skipped");
  });
  it("passes when at least one test passed, and reports how many were skipped", () => {
    testFile('test("adds", () => { assert.equal(1 + 1, 2); });\ntest("later", { skip: true }, () => { assert.equal(1, 2); });');
    const r = runTestsWithQuarantine("comp-mixed", ["src/a.ts"], dir);
    expect(r.status).toBe("pass");
    expect(r.counts).toEqual({ passed: 1, failed: 0, skipped: 1 });
    expect(r.notRun).toBeUndefined();
  });
  it("a skipped test is never re-run or 'forgiven': a failing test next to it still fails", () => {
    testFile('test("later", { skip: true }, () => {});\ntest("broken", () => { assert.equal(1, 2); });');
    const r = runTestsWithQuarantine("comp-skip-fail", ["src/a.ts"], dir);
    expect(r.status).toBe("fail");
    expect(r.reason).toContain("broken");
    expect(r.reason).not.toContain("later");
  });

  it("blocks a deterministic regression of a test that has already passed several times", () => {
    testFile('test("adds", () => { assert.equal(1 + 1, 2); });');
    for (let i = 0; i < 3; i++) expect(runTestsWithQuarantine("comp-regress", ["src/a.ts"], dir).status).toBe("pass");
    testFile('test("adds", () => { assert.equal(1 + 1, 3); });');
    const r = runTestsWithQuarantine("comp-regress", ["src/a.ts"], dir);
    expect(r.status).toBe("fail");
    expect(r.reason).toContain("adds");
    expect(r.quarantinedFailures).toEqual([]);
  });
  it("still blocks when a test that failed once in the past, and was then fixed, regresses again", () => {
    const good = 'test("adds", () => { assert.equal(1 + 1, 2); });';
    const bad = 'test("adds", () => { assert.equal(1 + 1, 3); });';
    testFile(good);
    for (let i = 0; i < 3; i++) runTestsWithQuarantine("comp-again", ["src/a.ts"], dir);
    testFile(bad);
    expect(runTestsWithQuarantine("comp-again", ["src/a.ts"], dir).status).toBe("fail");
    testFile(good);
    for (let i = 0; i < 2; i++) expect(runTestsWithQuarantine("comp-again", ["src/a.ts"], dir).status).toBe("pass");
    testFile(bad);
    expect(runTestsWithQuarantine("comp-again", ["src/a.ts"], dir).status).toBe("fail");
  });
  it("quarantines, without blocking, a known-flaky test whose failure does not reproduce on the re-run", () => {
    for (const result of ["pass", "fail", "pass"] as const) recordTestResult("comp-known-flaky", "flaky again", result);
    const marker = join(dir, "seen2.flag").replace(/\\/g, "/");
    testFile(`import { existsSync, writeFileSync } from "node:fs";\ntest("flaky again", () => { if (!existsSync("${marker}")) { writeFileSync("${marker}", "x"); assert.fail("first time only"); } });`);
    const r = runTestsWithQuarantine("comp-known-flaky", ["src/a.ts"], dir);
    expect(r.status).toBe("pass");
    expect(r.quarantinedFailures).toEqual(["flaky again"]);
  });
  it("runs no tests for input that contains no TypeScript file (README, .gitignore, Dockerfile)", () => {
    writeFileSync(join(dir, "README.md"), "# hi\n");
    writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
    writeFileSync(join(dir, "Dockerfile"), "FROM node:22\n");
    for (const f of ["README.md", ".gitignore", "Dockerfile"]) {
      expect(runTestsWithQuarantine("comp-docs", [f], dir).status).toBe("no_tests");
    }
  });

  it("finds and runs a test kept in test/ that imports the changed file (the sibling rule called this untested)", () => {
    mkdirSync(join(dir, "test"));
    writeFileSync(join(dir, "test", "a.test.ts"), `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { a } from "../src/a.ts";\ntest("a is 1", () => { assert.equal(a, 1); });\n`);
    const r = runTestsWithQuarantine("comp-dir", ["src/a.ts"], dir);
    expect(r.status).toBe("pass");
    expect(r.discovery?.tests).toEqual(["test/a.test.ts"]);
  });
  it("a failing test in test/ blocks, proving the discovered test really ran", () => {
    mkdirSync(join(dir, "test"));
    writeFileSync(join(dir, "test", "a.test.ts"), `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { a } from "../src/a.ts";\ntest("a is 2", () => { assert.equal(a, 2); });\n`);
    const r = runTestsWithQuarantine("comp-dir-fail", ["src/a.ts"], dir);
    expect(r.status).toBe("fail");
    expect(r.reason).toContain("a is 2");
  });
  it("reads leaf tests inside describe() blocks, and the suite itself is not counted as a test", () => {
    writeFileSync(join(dir, "src", "a.test.ts"), `import { describe, it } from "node:test";\nimport assert from "node:assert/strict";\ndescribe("group", () => {\n  it("one", () => { assert.ok(true); });\n  it("two", () => { assert.equal(1, 2); });\n});\n`);
    const r = runTestsWithQuarantine("comp-describe", ["src/a.ts"], dir);
    expect(r.status).toBe("fail");
    expect(r.reason).toContain("two");
    expect(r.reason).not.toContain("group");
    expect(r.reason).not.toContain("one");
  });
  it("a failing hook in a suite (no failing child) still fails instead of being swallowed as a rollup", () => {
    writeFileSync(join(dir, "src", "a.test.ts"), `import { describe, it, before } from "node:test";\nimport assert from "node:assert/strict";\ndescribe("needs setup", () => {\n  before(() => { throw new Error("setup broke"); });\n  it("never runs", () => { assert.ok(true); });\n});\n`);
    expect(runTestsWithQuarantine("comp-hook", ["src/a.ts"], dir).status).toBe("fail");
  });
  it("no_tests says what is uncovered and why, so it can be reported as 'not tested'", () => {
    const r = runTestsWithQuarantine("comp-unc", ["src/a.ts"], dir);
    expect(r.status).toBe("no_tests");
    expect(r.reason).toContain("src/a.ts");
    expect(r.discovery?.uncovered).toEqual(["src/a.ts"]);
  });
  it("runs a changed JavaScript file's tests too (the old rule ignored everything but .ts)", () => {
    mkdirSync(join(dir, "lib"));
    writeFileSync(join(dir, "lib", "m.js"), "export const m = 3;\n");
    writeFileSync(join(dir, "lib", "m.test.js"), `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { m } from "./m.js";\ntest("m", () => { assert.equal(m, 3); });\n`);
    const r = runTestsWithQuarantine("comp-js", ["lib/m.js"], dir);
    expect(r.status).toBe("pass");
    expect(r.discovery?.tests).toEqual(["lib/m.test.js"]);
  });
});

describe("runTestsWithQuarantine with no runner available", () => {
  it("reports not_installed with the purix tools hint instead of reaching for the network", () => {
    const d = mkdtempSync(join(tmpdir(), "purix-norunner-"));
    const prev = process.cwd();
    try {
      process.chdir(d);
      writeFileSync(join(d, "package.json"), JSON.stringify({ name: "p", type: "module", devDependencies: { "@types/node": "*" } }));
      mkdirSync(join(d, "src"));
      writeFileSync(join(d, "src", "a.ts"), "export const a = 1;\n");
      writeFileSync(join(d, "src", "a.test.ts"), 'import { test } from "node:test";\ntest("x", () => {});\n');
      const r = runTestsWithQuarantine("comp-norunner", ["src/a.ts"], d);
      expect(r.status).toBe("not_installed");
      expect(r.actionHint).toBe("Run: purix tools install tsx");
      expect(r.reason).toMatch(/tsx is not installed/);
    } finally {
      process.chdir(prev);
      closeDb();
      safeRmSync(d);
    }
  });
});
