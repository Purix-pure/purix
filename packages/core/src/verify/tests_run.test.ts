// runTestsWithQuarantine() end to end, with the repo's real tsx running tiny node:test projects: pass, no tests,
// consistent failure (re-run still fails), flaky failure (re-run passes) and unparseable output.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb } from "../manifest/store";
import { runTestsWithQuarantine } from "./tests";
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
  it("reports no_tests when no sibling test file exists", () => {
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
  it("passes when the test file runs cleanly but declares no tests", () => {
    testFile("const unused = 1; void unused;");
    expect(runTestsWithQuarantine("comp-empty", ["src/a.ts"], dir).status).toBe("pass");
  });
});
