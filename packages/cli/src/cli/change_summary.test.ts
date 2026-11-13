import { describe, it } from "node:test";
import { expect } from "expect";
import { formatChangeLines, formatCoverageLine } from "./change_summary.js";

describe("change summary (AI-13)", () => {
  it("one line per file with added and removed counts", () => {
    expect(formatChangeLines([{ path: "src/a.ts", added: 3, removed: 1, exact: true }, { path: "big.ts", added: 9000, removed: 8990, exact: false }])).toEqual([
      "  src/a.ts  +3 -1",
      "  big.ts  changed (8990 → 9000 lines; too large to count by line)",
    ]);
  });
  it("coverage line: passed, partial, and no result", () => {
    expect(formatCoverageLine({ verification: "passed", isolation: "bwrap", changedCount: 2, notTestedCount: 0 })).toContain("every changed file was reached by a test");
    expect(formatCoverageLine({ verification: "partial", isolation: "none", changedCount: 3, notTestedCount: 1 })).toContain("1 of 3 changed files had no test");
    expect(formatCoverageLine({ changedCount: 1, notTestedCount: 0 })).toContain("No verification result");
  });
});
