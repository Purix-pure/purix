// F06-04, first slice: the pure parts of changed-line coverage. The lcov text below was written by Node 22.23.4
// (`node --test --experimental-test-coverage --test-reporter=lcov`) for a file with a tested function f and an untested function g.
import { describe, it } from "node:test";
import { expect } from "expect";
import { changedLineNumbers, parseLcov, changedLineCoverage, parseLcovBranchMisses, typeOnlyLines } from "./changed_line_coverage";

const NODE_LCOV = `TN:
SF:src/m.mjs
FN:1,f
FN:7,g
FNDA:1,f
FNDA:0,g
DA:1,1
DA:2,1
DA:3,1
DA:4,1
DA:5,0
DA:6,1
DA:7,1
DA:8,0
DA:9,0
LH:6
LF:9
end_of_record
SF:src/m.test.mjs
DA:1,1
DA:2,1
end_of_record
`;

describe("changedLineNumbers", () => {
  it("a new file: every line is changed", () => {
    expect(changedLineNumbers(undefined, "a\nb\nc\n")).toEqual([1, 2, 3]);
  });
  it("an edited line and an added line, nothing else", () => {
    expect(changedLineNumbers("a\nb\nc\n", "a\nB\nc\nd\n")).toEqual([2, 4]);
  });
  it("a deleted line changes no line of the new text", () => {
    expect(changedLineNumbers("a\nb\nc\n", "a\nc\n")).toEqual([]);
  });
  it("an inserted block in the middle is found after the common head and tail are trimmed", () => {
    expect(changedLineNumbers("1\n2\n3\n4\n", "1\n2\nx\ny\n3\n4\n")).toEqual([3, 4]);
  });
  it("CRLF and LF text with the same lines are not a change", () => {
    expect(changedLineNumbers("a\r\nb\r\n", "a\nb\n")).toEqual([]);
  });
  it("a file too large to diff is read whole as changed (the stricter reading)", () => {
    const big = Array.from({ length: 2500 }, (_, i) => `l${i}`).join("\n");
    expect(changedLineNumbers(big + "\n", big + "\nmore\n").length).toBe(2501);
  });
});

describe("parseLcov", () => {
  it("reads SF and DA lines and ignores the rest", () => {
    const hits = parseLcov(NODE_LCOV);
    expect([...hits.keys()]).toEqual(["src/m.mjs", "src/m.test.mjs"]);
    expect(hits.get("src/m.mjs")?.get(5)).toBe(0);
    expect(hits.get("src/m.mjs")?.get(1)).toBe(1);
  });
  it("garbage gives an empty result, not an exception", () => {
    expect(parseLcov("not lcov at all").size).toBe(0);
  });
});

describe("changedLineCoverage", () => {
  const hits = parseLcov(NODE_LCOV);
  it("the research's case: a changed line in a function no test calls is listed as uncovered", () => {
    // research 06 section 5: a wrong operator in the untested function passed with file-level coverage reported
    const r = changedLineCoverage({ "src/m.mjs": [8] }, hits);
    expect(r.perFile["src/m.mjs"]).toEqual({ measured: true, executable: [8], uncovered: [8] });
    expect(r.ratio).toBe(0);
  });
  it("a changed line a test ran is covered", () => {
    expect(changedLineCoverage({ "src/m.mjs": [3] }, hits).ratio).toBe(1);
  });
  it("only executable lines count: a line the report does not list is neither covered nor uncovered", () => {
    const r = changedLineCoverage({ "src/m.mjs": [3, 20] }, hits);
    expect(r.perFile["src/m.mjs"]!.executable).toEqual([3]);
    expect(r.ratio).toBe(1);
  });
  it("a file the report does not mention is NOT MEASURED, and a changed file nobody measured gives no ratio at all", () => {
    const r = changedLineCoverage({ "src/other.ts": [1, 2] }, hits);
    expect(r.notMeasured).toEqual(["src/other.ts"]);
    expect(r.ratio).toBeUndefined();
  });
  it("matches a report that holds absolute paths", () => {
    const abs = parseLcov("SF:/tmp/work/src/a.ts\nDA:4,0\nend_of_record\n");
    expect(changedLineCoverage({ "src/a.ts": [4] }, abs).perFile["src/a.ts"]!.uncovered).toEqual([4]);
  });
  it("mixes files: totals add up", () => {
    const r = changedLineCoverage({ "src/m.mjs": [1, 5, 8] }, hits);
    expect([r.covered, r.total]).toEqual([1, 3]);
  });
});

// F06-04 wiring: branch records and type-only lines. The lcov text was written by Node 22.23.4 for the file in the comment.
// export function g(o) {      line 1
//   if (o.a > 100) {          line 2
//     return -1;              line 3
//   }                         line 4
//   return o.a;               line 5   (the only test calls g({a:1}))
// }
const BRANCH_LCOV = `SF:src/g.ts
BRDA:1,0,0,1
BRDA:2,1,0,0
DA:1,1
DA:2,1
DA:3,0
DA:4,1
DA:5,1
end_of_record
`;

describe("branch misses", () => {
  it("reads BRDA records with taken 0 or '-' and nothing else", () => {
    const m = parseLcovBranchMisses(`SF:a.ts\nBRDA:3,0,0,5\nBRDA:4,0,0,0\nBRDA:6,1,0,-\nend_of_record\n`);
    expect([...(m.get("a.ts") ?? [])]).toEqual([4, 6]);
  });
  it("counts a line that ran but has an untaken branch as not covered, and lists it as partial", () => {
    const r = changedLineCoverage({ "src/g.ts": [1, 2, 3, 4, 5] }, parseLcov(BRANCH_LCOV), parseLcovBranchMisses(BRANCH_LCOV));
    const f = r.perFile["src/g.ts"]!;
    expect(f.uncovered).toEqual([3]);
    expect(f.partial).toEqual([2]);
    expect(r.covered).toBe(3);
    expect(r.total).toBe(5);
  });
  it("without branch records the result is the older line-only reading", () => {
    const r = changedLineCoverage({ "src/g.ts": [1, 2, 3, 4, 5] }, parseLcov(BRANCH_LCOV));
    expect(r.perFile["src/g.ts"]!.partial).toBeUndefined();
    expect(r.covered).toBe(4);
  });
  it("lines in the ignore set are left out of the count", () => {
    const r = changedLineCoverage({ "src/g.ts": [1, 2, 3] }, parseLcov(BRANCH_LCOV), undefined, { "src/g.ts": new Set([3]) });
    expect(r.total).toBe(2);
    expect(r.perFile["src/g.ts"]!.uncovered).toEqual([]);
  });
});

describe("typeOnlyLines", () => {
  const lines = (text: string) => [...typeOnlyLines(text)].sort((a, b) => a - b);
  it("marks an interface including its body", () => {
    expect(lines("interface A {\n  x: number;\n}\nexport const a = 1;\n")).toEqual([1, 2, 3]);
  });
  it("marks a one-line type and an exported multi-line union", () => {
    expect(lines("export type T = number;\nconst z = 1;\nexport type U =\n  | 'a'\n  | 'b';\nconst y = 2;\n")).toEqual([1, 3, 4, 5]);
  });
  it("marks an object type with nested braces to its closing line only", () => {
    expect(lines("type O = {\n  f: () => void;\n  g: { h: number };\n};\nrun();\n")).toEqual([1, 2, 3, 4]);
  });
  it("does not mark code that merely mentions the words", () => {
    expect(lines("const interfaceName = 'x';\nconst t = typeof a;\nfunction type() { return 1; }\n")).toEqual([]);
  });
});
