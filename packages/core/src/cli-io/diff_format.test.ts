// src/cli-io/diff_format.test.ts
//
// Coverage for the diff-before-approval renderer (IDEA-078 finding #5).
// Regression targets: (1) one small edit in a large file must NOT dump the
// unchanged remainder; (2) the module must compile under
// noUncheckedIndexedAccess; (3) oversized inputs degrade to a message
// instead of building an unbounded table.
import { describe, it } from "node:test";
import { expect } from "expect";
import { formatFileDiff, formatChangeSetDiff, MAX_DIFF_CELLS } from "./diff_format";

const numbered = (n: number, prefix = "line"): string =>
  Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join("\n") + "\n";

describe("formatFileDiff", () => {
  it("renders a pure addition as a new file with + lines", () => {
    const out = formatFileDiff({ path: "a.ts", before: null, after: "x\ny\n" });
    expect(out).toContain("a.ts (new file, 2 lines)");
    expect(out).toContain("+ x");
    expect(out).toContain("+ y");
  });

  it("renders a deletion with - lines", () => {
    const out = formatFileDiff({ path: "a.ts", before: "x\n", after: null });
    expect(out).toContain("a.ts (deleted, 1 line)");
    expect(out).toContain("- x");
  });

  it("reports an unchanged file", () => {
    expect(formatFileDiff({ path: "a.ts", before: "x\n", after: "x\n" })).toContain("(unchanged)");
  });

  it("shows a single replaced line with add/remove counts", () => {
    const out = formatFileDiff({ path: "a.ts", before: "a\nb\nc\n", after: "a\nB\nc\n" });
    expect(out).toContain("(+1 / -1)");
    expect(out).toContain("- b");
    expect(out).toContain("+ B");
  });

  it("does not dump the unchanged remainder of a large file after one small edit", () => {
    const before = numbered(2000);
    const after = before.replace("line 5\n", "line FIVE\n");
    const out = formatFileDiff({ path: "big.ts", before, after });
    expect(out).toContain("- line 5");
    expect(out).toContain("+ line FIVE");
    expect(out).toContain("unchanged line");
    expect(out.split("\n").length).toBeLessThan(30);
    expect(out).not.toContain("line 1500");
  });

  it("shows leading context only on the side that touches the change", () => {
    const before = numbered(50);
    const after = before.replace("line 40\n", "line FORTY\n");
    const out = formatFileDiff({ path: "a.ts", before, after });
    expect(out).toContain("  line 39");
    expect(out).not.toContain("  line 10\n");
  });

  it("collapses a long unchanged run between two distant changes", () => {
    const before = numbered(100);
    const after = before.replace("line 3\n", "line THREE\n").replace("line 90\n", "line NINETY\n");
    const out = formatFileDiff({ path: "a.ts", before, after });
    expect(out).toContain("(+2 / -2)");
    expect(out).toMatch(/\.\.\. \(\d+ unchanged lines\) \.\.\./);
    expect(out).not.toContain("line 50");
  });

  it("handles insertion at the start and deletion at the end", () => {
    const out = formatFileDiff({ path: "a.ts", before: "a\nb\nc\n", after: "z\na\nb\n" });
    expect(out).toContain("+ z");
    expect(out).toContain("- c");
  });

  it("degrades to a summary instead of building an unbounded table", () => {
    const side = Math.ceil(Math.sqrt(MAX_DIFF_CELLS)) + 10;
    const out = formatFileDiff({
      path: "huge.ts",
      before: numbered(side, "old"),
      after: numbered(side, "new"),
    });
    expect(out).toContain("too large to diff in full");
  });

  it("reports line-ending-only changes without a misleading empty diff", () => {
    const out = formatFileDiff({ path: "a.ts", before: "a\nb\n", after: "a\r\nb\r\n" });
    expect(out).toContain("whitespace/line-ending change only");
  });
});

describe("formatChangeSetDiff", () => {
  it("skips unchanged files and joins changed ones", () => {
    const out = formatChangeSetDiff([
      { path: "same.ts", before: "x\n", after: "x\n" },
      { path: "new.ts", before: null, after: "y\n" },
    ]);
    expect(out).not.toContain("same.ts");
    expect(out).toContain("new.ts");
  });

  it("says so when nothing changed", () => {
    expect(formatChangeSetDiff([{ path: "a", before: "x", after: "x" }])).toContain("no file content changes");
  });
});