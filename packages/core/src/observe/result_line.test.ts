// packages/core/src/observe/result_line.test.ts
//
// The result line is added to every reply of a change tool, so its size is a cost. These tests hold the cap and say what a typical and
// a worst-case line costs. Token figures use Purix's own estimator (3.5 characters per token, a documented heuristic, not a
// tokenizer): they are estimates, and the characters are the measurement.
import { describe, it } from "node:test";
import { expect } from "expect";
import { formatResultLine, RESULT_LINE_MAX_CHARS, type ResultLineInput } from "./result_line.js";
import { estimateTokens } from "../llm/context/tokens.js";

const base: ResultLineInput = { tests: null, checksPassed: false, stopped: 0, costUsd: null, leftUsd: null, waiting: 0 };

describe("formatResultLine", () => {
  it("says nothing when there is nothing to say, and never 'left' on its own", () => {
    expect(formatResultLine(base)).toBeNull();
    expect(formatResultLine({ ...base, leftUsd: 4.5 })).toBeNull();
  });

  it("keeps its wording for a typical change", () => {
    const line = formatResultLine({ ...base, tests: { passed: 41, failed: 0, skipped: 2 }, checksPassed: true, stopped: 1, costUsd: 0.03, leftUsd: 1.97 });
    expect(line).toBe("Purix: 41 tests passed (2 skipped), 1 stopped, $0.03 spent, $1.97 left");
    // 71 characters, about 21 tokens by the 3.5-characters-per-token estimate
    expect(line!.length).toBeLessThan(80);
    expect(estimateTokens(line!)).toBeLessThanOrEqual(25);
  });

  it("never exceeds the cap, whatever the numbers", () => {
    const worst: ResultLineInput = { tests: { passed: 9_999_999, failed: 888_888, skipped: 777_777 }, checksPassed: true, stopped: 123_456, costUsd: 99_999, leftUsd: 99_999, waiting: 654_321 };
    const line = formatResultLine(worst)!;
    expect(line.length).toBeLessThanOrEqual(RESULT_LINE_MAX_CHARS);
    expect(line.startsWith("Purix: ")).toBe(true);
    expect(estimateTokens(line)).toBeLessThanOrEqual(Math.ceil(RESULT_LINE_MAX_CHARS / 3.5));
  });

  it("drops the least urgent parts first and keeps what needs a person", () => {
    const line = formatResultLine({ tests: { passed: 9_999_999, failed: 888_888, skipped: 777_777 }, checksPassed: true, stopped: 123_456, costUsd: 99_999, leftUsd: 99_999, waiting: 654_321 })!;
    expect(line).toContain("stopped");
    expect(line).toContain("waiting for approval");
    expect(line).not.toContain("left");
    // a part is dropped whole, never cut in half
    expect(line).not.toMatch(/,\s*$/);
  });

  it("is unchanged below the cap: nothing is dropped from a line that fits", () => {
    const line = formatResultLine({ ...base, tests: { passed: 5, failed: 1, skipped: 0 }, checksPassed: true, stopped: 2, waiting: 1, costUsd: 12.5, leftUsd: 80 })!;
    expect(line).toBe("Purix: 5 tests passed, 1 failed, 2 stopped, 1 waiting for approval, $12.50 spent, $80.00 left");
  });
});
