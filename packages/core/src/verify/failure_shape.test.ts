// AI-08: shapeFailure. Fixtures: tsc lines below are real `tsc -p --pretty false` output (tsc 5.7.2) from a scratch
// project; pytest and node text follow the shapes the parsers in tests_parsers.test.ts and tests.ts handle.
import { describe, it } from "node:test";
import { expect } from "expect";
import { shapeFailure, SHAPED_TEXT_MAX_CHARS, type FailureClass } from "./failure_shape";

const A_TS = ["export const limit: number = \"five\";", "export function f(x: number): string {", "  return undefinedThing + x;", "}", "import { nope } from \"./missing\";"].join("\n");

const REAL_TSC = [
  "src/a.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.",
  "src/a.ts(3,10): error TS2304: Cannot find name 'undefinedThing'.",
  "src/a.ts(5,22): error TS2307: Cannot find module './missing' or its corresponding type declarations.",
  "src/c.ts(2,34): error TS2322: Type 'number' is not assignable to type 'string'.",
].join("\n");

const REAL_SYNTAX = ["src/b.ts(2,1): error TS1109: Expression expected.", "src/b.ts(3,1): error TS1005: '}' expected."].join("\n");

const files = [{ path: "src/a.ts", content: A_TS }];

describe("shapeFailure: tsc", () => {
  it("keeps touched-file errors, adds code context, and only counts errors in other files", () => {
    const r = shapeFailure(REAL_TSC, { touchedPaths: ["src/a.ts"], files });
    expect(r.text).toContain("src/a.ts(1,14): error TS2322");
    expect(r.text).toContain("src/a.ts(3,10): error TS2304");
    expect(r.text).toContain("   1 | export const limit: number = \"five\";");
    expect(r.text).toContain("   3 |   return undefinedThing + x;");
    expect(r.text).toContain("1 more error in other files");
    expect(r.text).not.toContain("src/c.ts");
    expect(r.errorClass).toBe("type");
    expect(r.primary).toBe("src/a.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.");
  });

  it("orders touched-file errors first even when another file's error comes first in the output", () => {
    const raw = ["src/c.ts(2,34): error TS2322: Type 'number' is not assignable to type 'string'.", "src/a.ts(3,10): error TS2304: Cannot find name 'undefinedThing'."].join("\n");
    const r = shapeFailure(raw, { touchedPaths: ["src/a.ts"], files });
    expect(r.errorClass).toBe("name");
    expect(r.text.indexOf("src/a.ts")).toBeLessThan(r.text.indexOf("1 more error in other files"));
    expect(r.text).not.toContain("src/c.ts");
  });

  it("with no error in a touched file it says so and names no detail from other files (D-AI-3)", () => {
    const r = shapeFailure(REAL_TSC, { touchedPaths: ["src/z.ts"], files: [] });
    expect(r.text).toContain("No errors were reported in the files you edited.");
    expect(r.text).toContain("4 more errors in other files");
    expect(r.text).not.toContain("TS2322");
    // The class still comes from the first error so the call record can count this failure.
    expect(r.errorClass).toBe("type");
  });

  it("a 200-error dump shapes to under 4,500 characters, touched errors first, eight at most", () => {
    const lines: string[] = [];
    for (let i = 1; i <= 120; i++) lines.push(`src/other.ts(${i},1): error TS2322: Type 'string' is not assignable to type 'number'. ${"x".repeat(80)}`);
    for (let i = 1; i <= 80; i++) lines.push(`src/a.ts(${(i % 5) + 1},1): error TS2304: Cannot find name 'n${i}'. ${"y".repeat(400)}`);
    const r = shapeFailure(lines.join("\n"), { touchedPaths: ["src/a.ts"], files });
    expect(r.text.length).toBeLessThan(4500);
    expect(r.text.length).toBeLessThanOrEqual(SHAPED_TEXT_MAX_CHARS);
    expect(r.text.startsWith("src/a.ts")).toBe(true);
    expect(r.text).not.toContain("src/other.ts(");
    expect(r.text).toContain("72 more errors in the files you edited.");
    expect(r.text).toContain("120 more errors in other files");
    expect(r.errorClass).toBe("name");
  });

  it("joins indented continuation lines onto their error", () => {
    const raw = ["src/a.ts(1,14): error TS2322: Type '{ a: number; }' is not assignable to type 'P'.", "  Property 'b' is missing in type '{ a: number; }' but required in type 'P'.", "src/a.ts(3,10): error TS2304: Cannot find name 'q'."].join("\n");
    const r = shapeFailure(raw, { touchedPaths: ["src/a.ts"], files });
    expect(r.text).toContain("is not assignable to type 'P'. Property 'b' is missing");
    expect(r.text).toContain("TS2304");
  });

  it("accepts the pretty format, ANSI colours and CRLF line endings", () => {
    const raw = "\u001b[96msrc/a.ts\u001b[0m:\u001b[93m3\u001b[0m:\u001b[93m10\u001b[0m - \u001b[91merror\u001b[0m\u001b[90m TS2304: \u001b[0mCannot find name 'undefinedThing'.\r\n";
    // The pretty form puts colour codes inside the line; after stripping it must still parse.
    const r = shapeFailure(raw, { touchedPaths: ["src/a.ts"], files });
    expect(r.errorClass).toBe("name");
    expect(r.primary).toContain("src/a.ts(3,10): error TS2304");
    const crlf = shapeFailure(REAL_TSC.replace(/\n/g, "\r\n"), { touchedPaths: ["src/a.ts"], files });
    expect(crlf.text).toContain("src/a.ts(1,14)");
  });

  it("matches touched paths across Windows separators, a leading ./ and extra leading directories", () => {
    const a = shapeFailure("src\\a.ts(3,10): error TS2304: Cannot find name 'q'.", { touchedPaths: ["./src/a.ts"], files });
    expect(a.text).toContain("TS2304");
    const b = shapeFailure("packages/x/src/a.ts(3,10): error TS2304: Cannot find name 'q'.", { touchedPaths: ["src/a.ts"], files });
    expect(b.text).toContain("TS2304");
    expect(b.text).not.toContain("other files");
  });

  it("an error with no file (such as TS5112) is never counted as a touched file", () => {
    const r = shapeFailure("error TS5112: tsconfig.json is present but will not be loaded if files are specified on commandline.", { touchedPaths: ["src/a.ts"], files });
    expect(r.errorClass).toBe("other");
    expect(r.text).toContain("1 more error in other files");
  });

  it("omits context for a line outside the file and for an unknown file, and clips very long lines", () => {
    const long = `const x = "${"z".repeat(400)}";`;
    const r = shapeFailure(["src/a.ts(99,1): error TS2304: Cannot find name 'q'.", "src/new.ts(1,1): error TS2304: Cannot find name 'r'."].join("\n"), {
      touchedPaths: ["src/a.ts", "src/new.ts"],
      files: [...files, { path: "src/other.ts", content: long }],
    });
    expect(r.text).not.toContain(" | ");
    const clipped = shapeFailure("src/o.ts(1,1): error TS2304: Cannot find name 'q'.", { touchedPaths: ["src/o.ts"], files: [{ path: "src/o.ts", content: long }] });
    const ctx = clipped.text.split("\n").find((l) => l.includes(" | "))!;
    expect(ctx.length).toBeLessThan(180);
  });

  it("gives code context to the first three errors only", () => {
    const raw = [1, 2, 3, 4, 5].map((n) => `src/a.ts(${n},1): error TS2304: Cannot find name 'n${n}'.`).join("\n");
    const r = shapeFailure(raw, { touchedPaths: ["src/a.ts"], files });
    // 1st error has one context line (line 0 does not exist), 2nd and 3rd have two: 1 + 2 + 2.
    expect(r.text.split("\n").filter((l) => /^ {2}\s*\d+ \| /.test(l)).length).toBe(5);
  });
});

describe("shapeFailure: classes", () => {
  const cases: [string, string, FailureClass][] = [
    ["syntax (TS1xxx, real output)", REAL_SYNTAX, "syntax"],
    ["name (TS2304)", "src/a.ts(3,10): error TS2304: Cannot find name 'q'.", "name"],
    ["name (TS2305)", "src/a.ts(1,10): error TS2305: Module './x' has no exported member 'y'.", "name"],
    ["name (TS2307)", "src/a.ts(5,22): error TS2307: Cannot find module './missing' or its corresponding type declarations.", "name"],
    ["name (TS2552)", "src/a.ts(3,10): error TS2552: Cannot find name 'conole'. Did you mean 'console'?", "name"],
    ["type (other TS2xxx)", "src/a.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.", "type"],
    ["other (TS5xxx)", "src/a.ts(1,1): error TS5083: Cannot read file.", "other"],
    ["syntax (python SyntaxError)", "  File \"a.py\", line 3\n    def (:\n        ^\nSyntaxError: invalid syntax", "syntax"],
    ["syntax (IndentationError)", "IndentationError: unexpected indent", "syntax"],
    ["name (NameError)", "Traceback...\nNameError: name 'q' is not defined", "name"],
    ["name (ImportError)", "ImportError: cannot import name 'x'", "name"],
    ["name (node module)", "Error: Cannot find module './gone'", "name"],
    ["test_assertion (AssertionError)", "not ok 1 - adds\n  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal", "test_assertion"],
    ["timeout", "Command timed out after 120000ms", "timeout"],
    ["other", "something odd happened", "other"],
    ["other (empty)", "", "other"],
  ];
  for (const [name, raw, expected] of cases) {
    it(`classifies ${name}`, () => {
      expect(shapeFailure(raw, { touchedPaths: ["src/a.ts", "src/b.ts"], files: [] }).errorClass).toBe(expected);
    });
  }
});

describe("shapeFailure: pytest and generic output", () => {
  const PYTEST = [
    "============================= test session starts ==============================",
    "collected 3 items",
    "tests/test_a.py .F.                                                       [100%]",
    "=================================== FAILURES ===================================",
    "______________________________ test_limit ______________________________",
    "    def test_limit():",
    ">       assert limit() == 5",
    "E       assert 3 == 5",
    "E        +  where 3 = limit()",
    "tests/test_a.py:4: AssertionError",
    "=========================== short test summary info ============================",
    "FAILED tests/test_a.py::test_limit - assert 3 == 5",
    "========================= 1 failed, 2 passed in 0.03s ==========================",
  ].join("\n");

  it("keeps the FAILED and E lines and nothing else", () => {
    const r = shapeFailure(PYTEST, { touchedPaths: [], files: [] });
    expect(r.text.split("\n")).toEqual(["E       assert 3 == 5", "E        +  where 3 = limit()", "FAILED tests/test_a.py::test_limit - assert 3 == 5"]);
    expect(r.errorClass).toBe("test_assertion");
    expect(r.primary).toBe("E       assert 3 == 5");
  });

  it("a collection ERROR with an import failure is a name error; an unclassified failure is test_error", () => {
    const imp = shapeFailure("ERROR tests/test_a.py\nE   ModuleNotFoundError: No module named 'x'\nERROR tests/test_a.py - ModuleNotFoundError", { touchedPaths: [], files: [] });
    expect(imp.errorClass).toBe("name");
    const plain = shapeFailure("FAILED tests/test_a.py::test_x - ValueError: bad", { touchedPaths: [], files: [] });
    expect(plain.errorClass).toBe("test_error");
  });

  it("caps the number and length of pytest lines", () => {
    const raw = Array.from({ length: 100 }, (_, i) => `E   line ${i} ${"q".repeat(500)}`).join("\n");
    const r = shapeFailure(raw, { touchedPaths: [], files: [] });
    // 100 lines of 300 chars: the 40-line cap is reached first, then the character budget drops whole lines.
    expect(r.text).toContain("[... 60 lines past the first 40 not shown ...]");
    expect(r.text).toMatch(/\[\.\.\. \d+ more lines? cut \.\.\.\]/);
    expect(r.text.length).toBeLessThanOrEqual(SHAPED_TEXT_MAX_CHARS);
  });

  it("short unrecognised output passes through; long output keeps the first and last 2,000 characters with a marker", () => {
    expect(shapeFailure("  boom  ", { touchedPaths: [], files: [] }).text).toBe("boom");
    const raw = `${"a".repeat(2000)}${"m".repeat(3000)}${"z".repeat(2000)}`;
    const r = shapeFailure(raw, { touchedPaths: [], files: [] });
    expect(r.text.startsWith("a".repeat(2000))).toBe(true);
    expect(r.text.endsWith("z".repeat(2000))).toBe(true);
    expect(r.text).toContain("[... 3000 characters cut ...]");
    expect(r.text).not.toContain("m");
  });

  it("never throws on odd input", () => {
    expect(shapeFailure(undefined as unknown as string, { touchedPaths: [], files: [] })).toEqual({ errorClass: "other", primary: null, text: "", locations: [] });
    expect(() => shapeFailure("\u0000\uffff(1,2): error", { touchedPaths: [""], files: [{ path: "", content: "" }] })).not.toThrow();
  });
});

describe("shapeFailure: locations (AI-12)", () => {
  it("tsc: the places of the errors shown, in order, in touched files only", () => {
    const r = shapeFailure(REAL_TSC, { touchedPaths: ["src/a.ts"], files });
    expect(r.locations).toEqual([{ path: "src/a.ts", line: 1 }, { path: "src/a.ts", line: 3 }, { path: "src/a.ts", line: 5 }]);
  });

  it("tsc: at most eight places, no repeats", () => {
    const raw = Array.from({ length: 30 }, (_, i) => `src/a.ts(${i + 1},1): error TS2322: bad.`).concat(["src/a.ts(1,9): error TS2322: again."]).join("\n");
    const r = shapeFailure(raw, { touchedPaths: ["src/a.ts"], files });
    expect(r.locations.length).toBe(8);
    expect(new Set(r.locations.map((l) => l.line)).size).toBe(8);
  });

  it("pytest: file and line from the traceback, not from site-packages", () => {
    const raw = [
      "tests/test_a.py:12: AssertionError",
      "/usr/lib/python3/site-packages/pluggy/_callers.py:121: in _multicall",
      "src/a.py:7: in f",
      "E   assert 1 == 2",
      "FAILED tests/test_a.py::test_one - assert 1 == 2",
    ].join("\n");
    const r = shapeFailure(raw, { touchedPaths: [], files: [] });
    expect(r.errorClass).toBe("test_assertion");
    expect(r.locations).toEqual([{ path: "tests/test_a.py", line: 12 }, { path: "src/a.py", line: 7 }]);
  });

  it("node stack lines name a place; node: internals do not", () => {
    const raw = "Error: boom\n    at run (src/a.js:10:5)\n    at node:internal/modules/run_main:12:3";
    const r = shapeFailure(raw, { touchedPaths: [], files: [] });
    expect(r.locations).toEqual([{ path: "src/a.js", line: 10 }]);
  });

  it("output with no file and line gives no locations", () => {
    expect(shapeFailure("something went wrong at version 1.2.3:45", { touchedPaths: [], files: [] }).locations).toEqual([]);
  });
});

