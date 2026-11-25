// packages/core/src/manifest/index_extract.test.ts
//
// One test per problem the 2026-11-20 problem register reproduced on 0.4.0-beta.4 (probes IDX-01 to IDX-06), plus the edges the new extractor
// has to get right.
import { describe, it } from "node:test";
import { expect } from "expect";
import { extractFileRecords } from "./index_extract";
import { skippedByExtension } from "./indexer";

const names = (path: string, src: string, lang = "typescript"): string[] => (extractFileRecords(path, src, lang) ?? []).map((r) => r.symbol_name);
const rec = (path: string, src: string, name: string, lang = "typescript") => (extractFileRecords(path, src, lang) ?? []).find((r) => r.symbol_name === name);

describe("TypeScript: only real declarations are recorded (IDX-01, IDX-04, IDX-06)", () => {
  it("ignores `export` text inside a comment, a string and a template literal", () => {
    const src = [
      "// export function inComment() {}",
      "/* export const inBlock = 1; */",
      'const s = "export function inString() {}";',
      "const t = `export class InTemplate {}`;",
      "export function real() {}",
    ].join("\n");
    expect(names("a.ts", src)).toEqual(["real"]);
  });

  it("does not turn fixture text in a test file into components, and writes no duplicate for the same text twice", () => {
    const src = 'const A = "export const a = 1;";\nconst B = "export const a = 2;";\nexport function helper() {}\n';
    expect(names("y.test.ts", src)).toEqual(["helper"]);
  });

  it("records one entry per name in a file: overloads and merged declarations keep the first", () => {
    const src = "export function f(a: string): void;\nexport function f(a: number): void;\nexport function f(a: any): void {}\nexport const a = 1;\nexport type a = string;\n";
    expect(names("o.ts", src)).toEqual(["f", "a"]);
    expect(rec("o.ts", src, "f")?.signature).toBe("export function f(a: string): void");
  });
});

describe("TypeScript: every kind of export is recorded (IDX-02)", () => {
  const src = [
    "export default function defaultFn() {}",
    "export enum Color { Red }",
    "export const enum Dir { Up }",
    "export abstract class Base {}",
    "export namespace NS { export const inner = 1; }",
    "const q = 1;",
    "export { q };",
    "const w = 2;",
    "export { w as renamed };",
    "export { z } from './z';",
    "export * as ns from './n';",
    "export * from './star';",
    "export var v = 1;",
    "export declare function decl(a: number): void;",
    "export function plain() {}",
  ].join("\n");

  it("finds default, enum, const enum, abstract class, namespace, export lists, re-exports and var", () => {
    const got = names("a.ts", src);
    for (const n of ["defaultFn", "Color", "Dir", "Base", "NS", "q", "renamed", "z", "ns", "v", "decl", "plain"]) expect(got).toContain(n);
  });

  it("names nothing for `export * from` and for a name that is only inside a namespace body", () => {
    const got = names("a.ts", src);
    expect(got).not.toContain("star");
    expect(got).not.toContain("inner");
  });

  it("records an anonymous default export as `default`", () => {
    expect(names("d.ts", "export default class {}\n")).toEqual(["default"]);
    expect(names("e.ts", "export default (a: number) => a;\n")).toEqual(["default"]);
  });

  it("reads .mjs, .jsx and .tsx files with the right syntax", () => {
    expect(names("m.mjs", "export const m = 1;\n")).toEqual(["m"]);
    expect(names("c.tsx", "export const C = () => <div/>;\n")).toEqual(["C"]);
  });

  it("gives a file with no export no records, so the indexer adds its whole-file entry", () => {
    expect(names("none.ts", "const hidden = 1;\n")).toEqual([]);
  });
});

describe("TypeScript: signatures carry parameters and types (IDX-03)", () => {
  it("keeps parameters and the return type of a function", () => {
    expect(rec("a.ts", "export function real(a: number, b: string): boolean { return true }\n", "real")?.signature).toBe("export function real(a: number, b: string): boolean");
  });

  it("keeps the parameters of a function-valued constant and drops any other initialiser", () => {
    const src = 'export const f = async (a: string): Promise<void> => { };\nexport const k: number = 5;\nexport const apiKey = "sk-live-not-a-real-secret";\n';
    expect(rec("a.ts", src, "f")?.signature).toBe("export const f = async (a: string): Promise<void> =>");
    expect(rec("a.ts", src, "k")?.signature).toBe("export const k: number");
    expect(rec("a.ts", src, "apiKey")?.signature).toBe("export const apiKey");
  });

  it("keeps generics and heritage of classes and interfaces, and starts after any decorator", () => {
    const src = "@Injectable()\nexport class Svc<T> extends Base implements I { x = 1 }\nexport interface Box<A> extends Item { a: A }\n";
    expect(rec("a.ts", src, "Svc")?.signature).toBe("export class Svc<T> extends Base implements I");
    expect(rec("a.ts", src, "Box")?.signature).toBe("export interface Box<A> extends Item");
  });

  it("is cut at 300 characters and on one line", () => {
    const long = `export type Long = ${Array.from({ length: 80 }, (_, i) => `"member${i}"`).join(" | ")};\n`;
    const s = rec("a.ts", long, "Long")!.signature;
    expect(s.length).toBeLessThanOrEqual(300);
    expect(s).not.toContain("\n");
  });
});

describe("TypeScript: class methods (register item 5)", () => {
  const src = "export class K {\n  pub(a: number): void {}\n  private hidden() {}\n  protected guarded() {}\n  #secret() {}\n  static make(): K { return new K(); }\n  field = 1;\n}\nclass NotExported { m() {} }\n";
  it("records public methods as Class.method, and not private, protected, #private, fields or unexported classes", () => {
    expect(names("a.ts", src)).toEqual(["K", "K.pub", "K.make"]);
  });
  it("keeps a method's parameters", () => {
    expect(rec("a.ts", src, "K.pub")?.signature).toBe("pub(a: number): void");
  });
});

describe("reusable (register items 2 and 3)", () => {
  it("is true for an exported symbol in a source file and false in a test file", () => {
    expect(rec("src/a.ts", "export function f() {}\n", "f")?.reusable).toBe(true);
    expect(rec("src/a.test.ts", "export function f() {}\n", "f")?.reusable).toBe(false);
    expect(rec("src/__tests__/a.ts", "export function f() {}\n", "f")?.reusable).toBe(false);
    expect(rec("pkg/test_a.py", "def f(): pass\n", "f", "python")?.reusable).toBe(false);
    expect(rec("pkg/a.py", "def f(): pass\n", "f", "python")?.reusable).toBe(true);
  });
});

describe("Python (IDX-05)", () => {
  const src = [
    "class K:",
    '    """Docstring.',
    "def fake_in_docstring(): pass",
    '    """',
    "    def method(self, a: int) -> str: pass",
    "    def _private(self): pass",
    "    async def am(self): pass",
    "    class Inner:",
    "        def deep(self): pass",
    "",
    "def top(a,",
    '        b=")") -> int:',
    "    return 1",
    "",
    'x = """',
    "def in_string(): pass",
    '"""',
    "# def in_comment(): pass",
    "class _Hidden: pass",
    "async def top_async(): pass",
    "",
  ].join("\n");

  it("records top-level public definitions and the public methods of a class", () => {
    expect(names("m.py", src, "python")).toEqual(["K", "K.method", "K.am", "top", "top_async"]);
  });

  it("does not read a definition inside a docstring, a string or a comment", () => {
    const got = names("m.py", src, "python");
    for (const n of ["fake_in_docstring", "in_string", "in_comment"]) expect(got).not.toContain(n);
  });

  it("keeps parameters and return annotation, including a header that spans lines", () => {
    expect(rec("m.py", src, "K.method", "python")?.signature).toBe("def method(self, a: int) -> str");
    expect(rec("m.py", src, "top", "python")?.signature).toBe('def top(a, b=")") -> int');
  });

  it("copes with a byte-order mark, CRLF line endings and a backslash before a line break", () => {
    expect(names("b.py", "﻿def first(): pass\r\ndef second(): pass\r\n", "python")).toEqual(["first", "second"]);
    expect(names("c.py", 'x = "a\\\nb"\ndef after(): pass\n', "python")).toEqual(["after"]);
  });
});

describe("skippedByExtension (register item 7, IDX-07)", () => {
  it("groups by extension, biggest first, and names files that have none", () => {
    const got = skippedByExtension(["a.json", "b.JSON", "c.md", "Dockerfile", "LICENSE", ".gitignore", "d.go", "sub/e.go", "f.go"]);
    expect(got[0]).toEqual({ extension: ".go", count: 3 });
    expect(got[1]).toEqual({ extension: ".json", count: 2 });
    expect(got.map((g) => g.extension)).toEqual(expect.arrayContaining([".md", "Dockerfile", "LICENSE", ".gitignore"]));
  });
});
