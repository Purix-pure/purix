// F06-04 wiring: runTestsWithQuarantine asks node:test for coverage when `options.coverage` is given, and reports how much of the changed code
// a passing run ran. Real tsx, tiny projects. Off by default; never changes the verdict; leaves no file behind.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb } from "../manifest/store";
import { runTestsWithQuarantine } from "./tests";
import { changedLineNumbers } from "./changed_line_coverage";
import { resolveRealNodeModules } from "../test-support/real_node_modules";
import { safeRmSync } from "../platform/fs_retry.js";

const realModules = resolveRealNodeModules("tsx");
const skip = realModules ? false : "no node_modules with tsx found";

let cwd: string;
let dir: string;
let warn: typeof console.warn;
let log: typeof console.log;

const SRC = [
  "interface Opts {",
  "  a: number;",
  "}",
  "export function g(o: Opts): number {",
  "  if (o.a > 100) {",
  "    return -1;",
  "  }",
  "  return o.a;",
  "}",
  "",
].join("\n");

beforeEach(() => {
  cwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "purix-cov-"));
  process.chdir(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "p", type: "module", devDependencies: { "@types/node": "*" } }));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "g.ts"), SRC);
  writeFileSync(
    join(dir, "src", "g.test.ts"),
    `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { g } from "./g.ts";\ntest("g small", () => { assert.equal(g({ a: 1 }), 1); });\n`
  );
  if (realModules) symlinkSync(realModules, join(dir, "node_modules"), "junction");
  warn = console.warn;
  log = console.log;
  console.warn = () => {};
  console.log = () => {};
});
afterEach(() => {
  console.warn = warn;
  console.log = log;
  closeDb();
  process.chdir(cwd);
  safeRmSync(dir);
});

describe("runTestsWithQuarantine coverage (real tsx)", { skip }, () => {
  it("is absent when not asked for", () => {
    const r = runTestsWithQuarantine("cov-off", ["src/g.ts"], dir);
    expect(r.status).toBe("pass");
    expect(r.changedLineCoverage).toBeUndefined();
    expect(r.coverageNotMeasured).toBeUndefined();
  });

  it("reports the untaken branch as not covered and ignores the type-only lines", () => {
    const changed = { "src/g.ts": changedLineNumbers(undefined, SRC) };
    const r = runTestsWithQuarantine("cov-on", ["src/g.ts"], dir, { coverage: { changed, newText: { "src/g.ts": SRC } } });
    expect(r.status).toBe("pass");
    const c = r.changedLineCoverage!;
    expect(c).toBeDefined();
    const f = c.perFile["src/g.ts"]!;
    expect(f.measured).toBe(true);
    // lines 1 to 3 are the interface: not executable, so not counted as unrun
    expect(f.executable.some((n) => n <= 3)).toBe(false);
    // line 6 (`return -1`) never ran
    expect(f.uncovered).toContain(6);
    expect(c.ratio).toBeLessThan(1);
    expect(c.ratio).toBeGreaterThan(0);
  });

  it("does not change the verdict and leaves no report file behind", () => {
    const changed = { "src/g.ts": changedLineNumbers(undefined, SRC) };
    const before = runTestsWithQuarantine("cov-v1", ["src/g.ts"], dir);
    const after = runTestsWithQuarantine("cov-v2", ["src/g.ts"], dir, { coverage: { changed } });
    expect(after.status).toBe(before.status);
    expect(after.counts).toEqual(before.counts);
    expect(readdirSync(dir).filter((n) => n.startsWith(".purix-cov-"))).toEqual([]);
  });

  it("a changed file the report does not mention is not measured", () => {
    writeFileSync(join(dir, "src", "other.ts"), "export const o = 1;\n");
    const r = runTestsWithQuarantine("cov-nm", ["src/g.ts"], dir, { coverage: { changed: { "src/other.ts": [1] } } });
    expect(r.changedLineCoverage!.notMeasured).toEqual(["src/other.ts"]);
    expect(r.changedLineCoverage!.ratio).toBeUndefined();
  });
});
