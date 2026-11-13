// F06-04 remainder: how each runner is asked for an lcov report. The flags are the part that can break a run, so they are pinned here
// without the real tools (the live check with real Jest, Vitest and Mocha is in the handoff). Rules under test:
//  - a coverage request never turns a passing run into a failing one (project thresholds are switched off);
//  - a runner whose coverage package is missing gets no coverage flags, and the result says why (never "covered", never silent).
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coveragePlan } from "./tests.js";
import { safeRmSync } from "../platform/fs_retry.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "purix-covplan-"));
});
afterEach(() => safeRmSync(dir, { recursive: true, force: true }));

describe("coveragePlan", () => {
  it("node:test: Node's own lcov reporter, writing one file inside the project", () => {
    const p = coveragePlan("node:test", dir);
    expect(p.args).toContain("--experimental-test-coverage");
    expect(p.file?.startsWith(dir)).toBe(true);
    expect(p.dir).toBeUndefined();
  });

  it("jest: lcov into its own folder, with the project's thresholds switched off", () => {
    const p = coveragePlan("jest", dir);
    expect(p.args).toContain("--coverage");
    expect(p.args).toContain("--coverageReporters=lcov");
    expect(p.args).toContain("--coverageThreshold={}");
    expect(p.dir && p.file?.startsWith(p.dir)).toBeTruthy();
    expect(p.notMeasured).toBeUndefined();
  });

  it("vitest without a coverage package: no flags, and the reason is named", () => {
    const p = coveragePlan("vitest", dir);
    expect(p.args).toEqual([]);
    expect(p.file).toBeUndefined();
    expect(p.notMeasured).toMatch(/@vitest\/coverage-v8/);
  });

  it("vitest with @vitest/coverage-v8: lcov into its own folder, every threshold set to 0", () => {
    mkdirSync(join(dir, "node_modules", "@vitest", "coverage-v8"), { recursive: true });
    const p = coveragePlan("vitest", dir);
    expect(p.args).toContain("--coverage.enabled=true");
    for (const k of ["lines", "functions", "branches", "statements"]) expect(p.args).toContain(`--coverage.thresholds.${k}=0`);
    expect(p.notMeasured).toBeUndefined();
  });

  it("vitest with the istanbul package is accepted too", () => {
    mkdirSync(join(dir, "node_modules", "@vitest", "coverage-istanbul"), { recursive: true });
    expect(coveragePlan("vitest", dir).notMeasured).toBeUndefined();
  });

  it("mocha without c8: no wrapper, and the reason is named", () => {
    const p = coveragePlan("mocha", dir);
    expect(p.wrap).toBeUndefined();
    expect(p.notMeasured).toMatch(/c8/);
  });

  it("mocha with c8: c8 wraps the runner and does not enforce its own check", () => {
    mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(dir, "node_modules", ".bin", process.platform === "win32" ? "c8.cmd" : "c8"), "");
    const p = coveragePlan("mocha", dir);
    expect(p.wrap?.slice(1)).toContain("--reporter=lcov");
    expect(p.wrap).toContain("--check-coverage=false");
    expect(p.notMeasured).toBeUndefined();
  });
});
