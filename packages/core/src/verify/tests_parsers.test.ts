// Pure output parsers and tsx-command lookup from verify/tests.ts — previously reachable only by running real Jest/Vitest/Mocha.
import { describe, it } from "node:test";
import { expect } from "expect";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseJestJson, parseVitestJson, parseMochaJson, locateRunner, runnerToolId } from "./tests";
import { parseReporterOutput, ensureNodeTestReporter, REPORTER_LINE_PREFIX } from "./node_test_reporter";

describe("parseJestJson / parseVitestJson", () => {
  const report = JSON.stringify({
    testResults: [
      { assertionResults: [{ fullName: "suite works", status: "passed" }, { title: "loose", status: "failed" }] },
      { assertionResults: [{ fullName: "other", status: "passed" }] },
    ],
  });
  for (const [name, parse] of [["jest", parseJestJson], ["vitest", parseVitestJson]] as const) {
    it(`${name}: maps assertion results, falling back to title when fullName is absent`, () => {
      expect(parse(report)).toEqual([
        { name: "suite works", passed: true },
        { name: "loose", passed: false },
        { name: "other", passed: true },
      ]);
    });
    it(`${name}: returns [] for malformed JSON and for a report with no results`, () => {
      expect(parse("not json")).toEqual([]);
      expect(parse("{}")).toEqual([]);
      expect(parse(JSON.stringify({ testResults: [{}] }))).toEqual([]);
    });
  }
});

describe("parseMochaJson", () => {
  it("treats a test with no error (or an empty error object) as passed", () => {
    const out = parseMochaJson(JSON.stringify({ tests: [{ fullTitle: "a b", err: {} }, { title: "c" }, { fullTitle: "d", err: { message: "boom" } }] }));
    expect(out).toEqual([{ name: "a b", passed: true }, { name: "c", passed: true }, { name: "d", passed: false }]);
  });
  it("returns [] for malformed input or no tests", () => {
    expect(parseMochaJson("nope")).toEqual([]);
    expect(parseMochaJson("{}")).toEqual([]);
  });
});

describe("parseReporterOutput (Purix's own reporter protocol, not Node's console text)", () => {
  const line = (o: object) => REPORTER_LINE_PREFIX + JSON.stringify(o);
  it("reads one result per PURIX_TEST line and ignores everything else on stdout", () => {
    const out = ["some console noise", line({ name: "adds", passed: true, file: "a.test.ts" }), "ok 4 - has no type block at all", line({ name: "subtracts", passed: false, file: null })].join("\n");
    expect(parseReporterOutput(out)).toEqual([{ name: "adds", passed: true, file: "a.test.ts" }, { name: "subtracts", passed: false, file: null }]);
  });
  it("a TAP-looking line without the prefix is never a test result (the old parser's ambiguity is gone by construction)", () => {
    expect(parseReporterOutput("ok 4 - has no type block at all\nnot ok 5 - also not mine")).toEqual([]);
  });
  it("skips malformed or truncated protocol lines instead of throwing", () => {
    expect(parseReporterOutput(REPORTER_LINE_PREFIX + "{\"name\":\"half")).toEqual([]);
    expect(parseReporterOutput(line({ name: 5, passed: true }))).toEqual([]);
  });
  it("writes the reporter under .purix/tmp and rewrites it if it was altered", () => {
    const d = mkdtempSync(join(tmpdir(), "purix-reporter-"));
    try {
      const p = ensureNodeTestReporter(d);
      expect(p).toBe(join(d, ".purix", "tmp", "purix-node-reporter.mjs"));
      writeFileSync(p, "tampered");
      expect(ensureNodeTestReporter(d)).toBe(p);
      expect(readFileSync(p, "utf-8")).toContain("purixReporter");
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});

describe("locateRunner / runnerToolId", () => {
  it("maps each framework to its tools-broker id (node:test runs through tsx)", () => {
    expect(runnerToolId("jest")).toBe("jest");
    expect(runnerToolId("vitest")).toBe("vitest");
    expect(runnerToolId("mocha")).toBe("mocha");
    expect(runnerToolId("node:test")).toBe("tsx");
  });
  it("finds the project's own runner, and returns null (never a package-runner fallback) when there is none", () => {
    const dir = mkdtempSync(join(tmpdir(), "purix-tsx-"));
    try {
      expect(locateRunner(dir, "node:test")).toBeNull();
      mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
      writeFileSync(join(dir, "node_modules", ".bin", "tsx"), "");
      const loc = locateRunner(dir, "node:test");
      expect(loc?.command).toEqual([join(dir, "node_modules", ".bin", "tsx")]);
      expect(loc?.source).toBe("project");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
