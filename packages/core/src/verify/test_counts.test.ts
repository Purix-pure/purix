// A6-1 (research 06, D06; blocker 5): a pass must mean at least one test ran and passed, counted from the runner's own report.
//
// Before: Vitest, Mocha and node:test returned "pass" for a run in which every test was skipped or marked todo, and Mocha and
// node:test also for a file that declares no tests at all (measured on unchanged code with scratch/probe_counts.mts: 4 of 4
// runners passed "all skipped" and "only todo"). A skipped test was parsed as a failure, re-run, and forgiven by the re-run's
// exit code; Mocha's pending tests were parsed as passes.
//
// The fixtures in test_fixtures/runner_output/ are the REAL stdout of Jest 29.7.0, Vitest 4.1.12 and Mocha 12.0.3 for each
// scenario (captured with the runners' own reporters), so the parsers are tested against what the runners print, not against a
// guess at it.
import { describe, it } from "node:test";
import { expect } from "expect";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseJestJson, parseVitestJson, parseMochaJson } from "./tests";
import { assessTestReport, parsePytestSummary } from "./test_counts";

const fixture = (name: string): { exitCode: number; stdout: string } =>
  JSON.parse(readFileSync(join(import.meta.dirname, "test_fixtures", "runner_output", `${name}.json`), "utf8"));

const parsers = { jest: parseJestJson, vitest: parseVitestJson, mocha: parseMochaJson } as const;

describe("runner parsers tell skipped and todo apart from passed and failed (real runner output)", () => {
  for (const fw of ["jest", "vitest", "mocha"] as const) {
    it(`${fw}: a mix of passed, skipped and todo gives one passed and two skipped, none failed`, () => {
      const parsed = parsers[fw](fixture(`${fw}.mixed`).stdout);
      expect(parsed.length).toBe(3);
      expect(parsed.filter((t) => t.skipped).length).toBe(2);
      expect(parsed.filter((t) => !t.skipped && t.passed).length).toBe(1);
      expect(parsed.filter((t) => !t.skipped && !t.passed).length).toBe(0);
    });
    it(`${fw}: a failing test is failed, not skipped`, () => {
      const parsed = parsers[fw](fixture(`${fw}.failed`).stdout);
      expect(parsed.map((t) => ({ passed: t.passed, skipped: Boolean(t.skipped) }))).toEqual([{ passed: false, skipped: false }]);
    });
    it(`${fw}: a passing test is passed`, () => {
      const parsed = parsers[fw](fixture(`${fw}.passed`).stdout);
      expect(parsed.map((t) => ({ passed: t.passed, skipped: Boolean(t.skipped) }))).toEqual([{ passed: true, skipped: false }]);
    });
  }
});

describe("assessTestReport: the count rule", () => {
  const t = (passed: boolean, skipped = false) => ({ name: "x", passed, ...(skipped ? { skipped: true } : {}) });

  it("a report with no tests and exit 0 is 'no_tests_ran', not a pass", () => {
    expect(assessTestReport([], 0)).toMatchObject({ verdict: "no_tests_ran", passed: 0, failed: 0, skipped: 0 });
  });
  it("only skipped or todo entries and exit 0 is 'all_skipped'", () => {
    expect(assessTestReport([t(false, true), t(false, true)], 0)).toMatchObject({ verdict: "all_skipped", passed: 0, skipped: 2 });
  });
  it("one passed test among skipped ones is a run, and says how many were skipped", () => {
    expect(assessTestReport([t(true), t(false, true)], 0)).toMatchObject({ verdict: "ran", passed: 1, skipped: 1, failed: 0 });
  });
  it("a failure is a run whatever else was skipped", () => {
    expect(assessTestReport([t(false), t(false, true)], 1)).toMatchObject({ verdict: "ran", failed: 1, skipped: 1 });
  });
  it("an empty report with a non-zero exit is not decided here: the run may have crashed (a syntax error), which stays a failure", () => {
    expect(assessTestReport([], 1)).toMatchObject({ verdict: "unreported" });
  });
  it("a Vitest 5 style run (JSON goes to a file, stdout empty, exit 0) reads as 'no_tests_ran', never as a silent pass", () => {
    expect(assessTestReport(parseVitestJson(""), 0).verdict).toBe("no_tests_ran");
  });
});

describe("parsePytestSummary: pytest exits 0 when every test is skipped", () => {
  it("counts passed, skipped, xfailed from the last summary line", () => {
    expect(parsePytestSummary("....\n=== 3 passed, 2 skipped in 0.02s ===\n")).toEqual({ passed: 3, failed: 0, skipped: 2, xfailed: 0 });
  });
  it("all skipped has zero passed", () => {
    expect(parsePytestSummary("ss\n2 skipped in 0.01s\n")).toMatchObject({ passed: 0, skipped: 2 });
  });
  it("quiet mode summary", () => {
    expect(parsePytestSummary("1 passed in 0.01s")).toMatchObject({ passed: 1, skipped: 0 });
  });
  it("xfailed does not count as passed", () => {
    expect(parsePytestSummary("1 xfailed in 0.01s")).toMatchObject({ passed: 0, xfailed: 1 });
  });
  it("returns null when there is no summary line (do not guess)", () => {
    expect(parsePytestSummary("garbage")).toBeNull();
  });
});
