import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeLines, duplicatedLines, measureDuplication, measureChangeDuplication, duplicationNote, duplicationEnabled, DUP_WINDOW } from "./duplication.js";
import { metricsDetail } from "./metrics_detail.js";
import { safeRmSync } from "../platform/fs_retry.js";

const block = (n: number, tag = "x") => Array.from({ length: n }, (_, i) => `const ${tag}${i} = compute(${i}, "${tag}");`).join("\n");

describe("normalizeLines", () => {
  it("drops blanks, comments and bare punctuation, and collapses spaces", () => {
    expect(normalizeLines("// c\n\n  a   =  1;\n}\n/* x\n y */\nb = 2;\n# py")).toEqual(["a = 1;", "b = 2;"]);
  });
});

describe("measureDuplication", () => {
  it("counts lines in a block of 6+ that repeats elsewhere, before and after", () => {
    const other = block(8);
    const d = measureDuplication([{ path: "a.ts", before: "const q = 1;", after: `${block(8)}\nconst q = 1;` }], [other]);
    expect(d).toMatchObject({ before: 0, after: 8, linesChecked: 9, filesCompared: 1, cut: false });
  });
  it("a block shorter than the window is not counted", () => {
    expect(DUP_WINDOW).toBe(6);
    expect(measureDuplication([{ path: "a.ts", before: undefined, after: block(5) }], [block(5)]).after).toBe(0);
  });
  it("both copies of a block repeated inside the changed file count", () => {
    expect(duplicatedLines(normalizeLines(`${block(6)}\n${block(6)}`), new Set())).toBe(12);
  });
});

describe("measureChangeDuplication", () => {
  let dir = "";
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "purix-dup-")); mkdirSync(join(dir, "src")); mkdirSync(join(dir, "node_modules")); });
  afterEach(() => safeRmSync(dir));
  it("reads other code files, leaves the changed file and node_modules out, and never records text", () => {
    writeFileSync(join(dir, "src", "other.ts"), block(7));
    writeFileSync(join(dir, "node_modules", "dep.js"), block(7));
    writeFileSync(join(dir, "src", "a.ts"), "const q = 1;");
    const d = measureChangeDuplication([{ path: "src/a.ts", new_content: block(7) }], dir)!;
    expect(d.after).toBe(7);
    expect(d.filesCompared).toBe(1);
    expect(JSON.stringify(metricsDetail({ duplication: d }))).not.toContain("compute");
  });
  it("test files and non-code files give null, and a missing folder never throws", () => {
    expect(measureChangeDuplication([{ path: "src/a.test.ts", new_content: block(7) }, { path: "README.md", new_content: "x" }], dir)).toBeNull();
    expect(() => measureChangeDuplication([{ path: "a.ts", new_content: block(7) }], join(dir, "nope"))).not.toThrow();
  });
});

describe("note and switch", () => {
  it("states the direction and says a cut read is a lower bound", () => {
    expect(duplicationNote({ before: 2, after: 8, linesChecked: 20, filesCompared: 3, cut: true })).toMatch(/6 more than before.*lower bound/);
    expect(duplicationNote({ before: 4, after: 4, linesChecked: 9, filesCompared: 1, cut: false })).toContain("the same as before");
    expect(duplicationNote(undefined)).toBeNull();
  });
  it("is off unless the variable is set", () => {
    const prev = process.env["PURIX_DUPLICATION_CHECK"];
    delete process.env["PURIX_DUPLICATION_CHECK"];
    expect(duplicationEnabled()).toBe(false);
    process.env["PURIX_DUPLICATION_CHECK"] = "1";
    expect(duplicationEnabled()).toBe(true);
    if (prev === undefined) delete process.env["PURIX_DUPLICATION_CHECK"]; else process.env["PURIX_DUPLICATION_CHECK"] = prev;
  });
});
