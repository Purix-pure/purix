// F06-04 wiring: verifyInSandbox asks the provider for coverage of the changed source lines, folds the answer into `changedCoverage`, says which
// lines no test ran, and never blocks on it.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyInSandbox } from "./sandbox.js";
import { closeDb } from "../manifest/store.js";
import { registerLanguageProvider } from "../language/registry.js";
import type { LanguageProvider } from "../language/provider.js";
import { uncoveredLinesNote } from "../verify/changed_line_coverage.js";
import type { RunTestsOptions, TestRunResult } from "../verify/tests.js";
import { safeRmSync } from "../platform/fs_retry.js";

let cwd: string, dir: string, logs: string[], realLog: typeof console.log;
beforeEach(() => { cwd = process.cwd(); dir = mkdtempSync(join(tmpdir(), "purix-covsb-")); process.chdir(dir); logs = []; realLog = console.log; console.log = (...a: unknown[]) => { logs.push(a.join(" ")); }; });
afterEach(() => { console.log = realLog; closeDb(); process.chdir(cwd); safeRmSync(dir); });

const provider = (id: string, runTests: (o?: RunTestsOptions) => TestRunResult): LanguageProvider => ({
  id, minSupportedVersion: "1.0.0", detect: () => false,
  verify: () => ({ status: "pass", isolation: "none" }),
  runTests: (_c, _f, _d, o) => runTests(o),
  checkIdiom: () => ({ ran: true, findings: [] }),
  auditDependencies: async () => ({ pinning: [], vulnerabilities: [], ran: false }),
  getFingerprint: async () => ({}),
});

describe("verifyInSandbox changed-line coverage", () => {
  it("asks for the changed lines of a source file, not of a test file", () => {
    let asked: RunTestsOptions["coverage"];
    registerLanguageProvider(provider("cov_ask", (o) => { asked = o?.coverage; return { status: "pass", quarantinedFailures: [] }; }));
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\nexport const b = 2;\n");
    verifyInSandbox("c", [
      { path: "a.ts", new_content: "export const a = 1;\nexport const b = 3;\n" },
      { path: "a.test.ts", new_content: "// t\n" },
    ], dir, "cov_ask");
    expect(asked).toBeDefined();
    expect(Object.keys(asked!.changed)).toEqual(["a.ts"]);
    expect(asked!.changed["a.ts"]).toEqual([2]);
  });

  it("folds a measured result into changedCoverage and names the lines no test ran, without blocking", () => {
    registerLanguageProvider(provider("cov_sum", () => ({
      status: "pass", quarantinedFailures: [],
      changedLineCoverage: {
        perFile: { "a.ts": { measured: true, executable: [1, 2, 3], uncovered: [3], partial: [2] } },
        total: 3, covered: 1, ratio: 1 / 3, notMeasured: [],
      },
    })));
    writeFileSync(join(dir, "a.ts"), "x\n");
    const r = verifyInSandbox("c", [{ path: "a.ts", new_content: "export const a = 1;\nif (a) {}\nthrow 1;\n" }], dir, "cov_sum");
    expect(r.status).toBe("pass");
    const cc = r.status === "pass" ? r.changedCoverage : undefined;
    expect(cc).toBeDefined();
    expect(cc!.ratio).toBeCloseTo(1 / 3);
    expect(cc!.uncovered).toEqual({ "a.ts": [3] });
    expect(cc!.partial).toEqual({ "a.ts": [2] });
  });

  it("uncoveredLinesNote names the lines and says nothing is blocked; it is silent when everything ran", () => {
    expect(uncoveredLinesNote({ covered: 1, total: 3, ratio: 1 / 3, uncovered: { "a.ts": [3, 4] }, partial: { "a.ts": [2] }, notMeasured: [] })).toBe(
      "Changed lines no test ran: a.ts:3,4. A branch on a line of a.ts was run only one way. Information only, nothing is blocked."
    );
    expect(uncoveredLinesNote({ covered: 3, total: 3, ratio: 1, uncovered: {}, notMeasured: [] })).toBeUndefined();
    expect(uncoveredLinesNote(undefined)).toBeUndefined();
  });

  it("a provider with no producer leaves the field out, never a ratio of 1", () => {
    registerLanguageProvider(provider("cov_none", () => ({ status: "pass", quarantinedFailures: [], coverageNotMeasured: "no producer" })));
    writeFileSync(join(dir, "a.ts"), "x\n");
    const r = verifyInSandbox("c", [{ path: "a.ts", new_content: "export const a = 1;\n" }], dir, "cov_none");
    expect(r.status).toBe("pass");
    const cc = r.status === "pass" ? r.changedCoverage : undefined;
    expect(cc).toBeDefined();
    expect(cc!.ratio).toBeUndefined();
    expect(cc!.whyNotMeasured).toContain("no producer");
    expect(cc!.notMeasured).toEqual(["a.ts"]);
  });
});
