// Pure output parsers and tsx-command lookup from verify/tests.ts — previously reachable only by running real Jest/Vitest/Mocha.
import { describe, it } from "node:test";
import { expect } from "expect";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseJestJson, parseVitestJson, parseMochaJson, parseTapOutput, tsxCommand } from "./tests";

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

describe("parseTapOutput", () => {
  it("keeps only leaf tests (type: 'test'), skipping suite rollups, and reads pass/fail", () => {
    const tap = [
      "TAP version 13",
      "    ok 1 - adds",
      "      ---",
      "      type: 'test'",
      "      ...",
      "    not ok 2 - subtracts",
      "      ---",
      "      type: 'test'",
      "      ...",
      "ok 3 - the suite",
      "  ---",
      "  type: 'suite'",
      "  ...",
    ].join("\n");
    expect(parseTapOutput(tap)).toEqual([{ name: "adds", passed: true }, { name: "subtracts", passed: false }]);
  });
  it("reads leaf tests that carry no `type:` line (Node 22.13.0), still skipping suites", () => {
    // Verbatim shape captured from `tsx --test --test-reporter=tap` on Node v22.13.0:
    // leaf tests have no type line; describe() rollups have `type: 'suite'`.
    const tap = [
      "TAP version 13",
      "# Subtest: outer",
      "    # Subtest: leaf pass",
      "    ok 1 - leaf pass",
      "      ---",
      "      duration_ms: 0.66485",
      "      ...",
      "    # Subtest: leaf fail",
      "    not ok 2 - leaf fail",
      "      ---",
      "      duration_ms: 1.244414",
      "      failureType: 'testCodeFailure'",
      "      error: 'boom'",
      "      code: 'ERR_ASSERTION'",
      "      ...",
      "    1..2",
      "not ok 1 - outer",
      "  ---",
      "  duration_ms: 3.146311",
      "  type: 'suite'",
      "  failureType: 'subtestsFailed'",
      "  ...",
      "1..1",
    ].join("\n");
    expect(parseTapOutput(tap)).toEqual([{ name: "leaf pass", passed: true }, { name: "leaf fail", passed: false }]);
  });
  it("returns [] for output with no TAP result lines", () => {
    expect(parseTapOutput("hello\nworld")).toEqual([]);
  });
});

describe("tsxCommand", () => {
  it("prefers a local node_modules/.bin/tsx and otherwise falls back to npx", () => {
    const dir = mkdtempSync(join(tmpdir(), "purix-tsx-"));
    try {
      expect(tsxCommand(dir)).toEqual(["npx", "tsx"]);
      mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
      writeFileSync(join(dir, "node_modules", ".bin", "tsx"), "");
      expect(tsxCommand(dir)).toEqual([join(dir, "node_modules", ".bin", "tsx")]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});