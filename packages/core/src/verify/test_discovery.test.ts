import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { safeRmSync } from "../platform/fs_retry.js";
import { discoverRelatedTests, extractSpecifiers, isTestPath } from "./test_discovery.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "purix-disc-")); });
afterEach(() => safeRmSync(dir));
const put = (rel: string, body = "export const x = 1;\n") => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), body); };

describe("isTestPath", () => {
  it("recognises Node, Jest and Vitest conventions, and not ordinary sources", () => {
    for (const p of ["a.test.ts", "a.spec.tsx", "src/a.test.js", "__tests__/a.ts", "test/a.ts", "a_test.js", "test-a.mjs"]) expect(isTestPath(p)).toBe(true);
    for (const p of ["a.ts", "src/contest.ts", "src/latest.ts", "tests/helper.ts", "a.test.json"]) expect(isTestPath(p)).toBe(false);
  });
});

describe("extractSpecifiers", () => {
  it("finds static, multi-line, side-effect, dynamic and require forms; ignores non-literal specifiers", () => {
    const src = `import a from "./a";\nimport {\n  b,\n  c\n} from '../b.js';\nimport "./side";\nexport * from "./re";\nconst d = await import("./dyn");\nconst e = require("./cjs");\nconst f = await import(name);\n`;
    expect(extractSpecifiers(src).sort()).toEqual(["../b.js", "./a", "./cjs", "./dyn", "./re", "./side"]);
  });
});

describe("discoverRelatedTests", () => {
  it("the old rule still works: a sibling .test.ts is found", () => {
    put("src/a.ts"); put("src/a.test.ts", 'import { x } from "./a";');
    expect(discoverRelatedTests(["src/a.ts"], dir).tests).toEqual(["src/a.test.ts"]);
  });
  it("finds tests kept in test/ and __tests__/, and .spec files, by import", () => {
    put("src/cart.ts"); put("test/cart.test.ts", 'import { x } from "../src/cart";'); put("src/__tests__/cart.ts", 'import { x } from "../cart.js";'); put("src/cart.spec.ts", 'import "./cart";');
    const d = discoverRelatedTests(["src/cart.ts"], dir);
    expect(d.tests).toEqual(["src/__tests__/cart.ts", "src/cart.spec.ts", "test/cart.test.ts"]);
    expect(d.uncovered).toEqual([]);
  });
  it("follows imports through intermediate files (a test of an importer covers the change)", () => {
    put("src/util.ts"); put("src/service.ts", 'import { x } from "./util";'); put("test/service.test.ts", 'import { x } from "../src/service";');
    const d = discoverRelatedTests(["src/util.ts"], dir);
    expect(d.tests).toEqual(["test/service.test.ts"]);
    expect(d.reasons["test/service.test.ts"]![0]).toContain("depends on src/util.ts");
  });
  it("handles import cycles without looping", () => {
    put("src/a.ts", 'import "./b";'); put("src/b.ts", 'import "./a";'); put("test/a.test.ts", 'import "../src/b";');
    expect(discoverRelatedTests(["src/a.ts"], dir).tests).toEqual(["test/a.test.ts"]);
  });
  it("resolves directory indexes and tsconfig path aliases (with comments in the tsconfig)", () => {
    put("tsconfig.json", '{\n // comment\n "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"], }, },\n}\n');
    put("src/lib/index.ts"); put("test/lib.test.ts", 'import { x } from "@/lib";');
    expect(discoverRelatedTests(["src/lib/index.ts"], dir).tests).toEqual(["test/lib.test.ts"]);
  });
  it("works for JavaScript projects", () => {
    put("lib/m.js", "module.exports = 1;"); put("test/m.test.js", 'const m = require("../lib/m");');
    expect(discoverRelatedTests(["lib/m.js"], dir).tests).toEqual(["test/m.test.js"]);
  });
  it("a changed test file selects itself (the old rule never ran it)", () => {
    put("src/a.test.ts");
    const d = discoverRelatedTests(["src/a.test.ts"], dir);
    expect(d.tests).toEqual(["src/a.test.ts"]);
    expect(d.reasons["src/a.test.ts"]).toEqual(["is the changed file"]);
  });
  it("reports changed sources that no test relates to, instead of treating them as covered", () => {
    put("src/a.ts"); put("src/b.ts"); put("src/a.test.ts", 'import "./a";');
    const d = discoverRelatedTests(["src/a.ts", "src/b.ts"], dir);
    expect(d.tests).toEqual(["src/a.test.ts"]);
    expect(d.uncovered).toEqual(["src/b.ts"]);
  });
  it("a brand-new file that is not on disk yet is still handled, and uncovered if nothing names it", () => {
    put("src/a.ts");
    expect(discoverRelatedTests(["src/new.ts"], dir).uncovered).toEqual(["src/new.ts"]);
  });
  it("ignores node_modules, dist and .purix", () => {
    put("src/a.ts"); put("node_modules/p/a.test.ts", 'import "../../../src/a";'); put("dist/a.test.js", ""); put(".purix/tmp/a.test.ts", "");
    expect(discoverRelatedTests(["src/a.ts"], dir).tests).toEqual([]);
  });
  it("non-JS/TS changed files are not this module's business", () => {
    put("README.md", "x");
    const d = discoverRelatedTests(["README.md"], dir);
    expect(d.tests).toEqual([]);
    expect(d.uncovered).toEqual([]);
  });
});

describe("discoverRelatedTests with absolute paths", () => {
  it("a checkout under a folder named test does not make the changed file look like a test", () => {
    const base = join(dir, "test", "purix", "work");
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, "a.ts"), "export const x = 1;\n");
    writeFileSync(join(base, "a.test.ts"), 'import { x } from "./a";\n');
    const r = discoverRelatedTests([join(base, "a.ts")], base);
    expect(r.tests).toEqual(["a.test.ts"]);
  });
});
