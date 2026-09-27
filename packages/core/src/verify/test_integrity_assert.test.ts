// TEST-REPORT F5: the integrity check used to recognise only expect(...), so removing node:assert
// assertions from a node:test file went unflagged.
import { describe, it } from "node:test";
import { expect } from "expect";
import { checkTestIntegrity } from "./test_integrity";

const file = (body: string) => `import { it } from "node:test";\nimport assert from "node:assert/strict";\nit("a", (t) => { ${body} });\n`;
const check = (before: string, after: string) =>
  checkTestIntegrity([{ path: "src/a.test.ts", content: before }], [{ path: "src/a.test.ts", content: after }]);

describe("checkTestIntegrity — node:assert", () => {
  for (const [label, assertion] of [
    ["assert.equal", 'assert.equal(1, 1);'],
    ["assert.strictEqual", 'assert.strictEqual(1, 1);'],
    ["assert.ok", 'assert.ok(true);'],
    ["assert(...)", 'assert(true);'],
    ["assert.strict.deepEqual", 'assert.strict.deepEqual({}, {});'],
    ["t.assert.equal (node:test context)", 't.assert.equal(1, 1);'],
  ] as const) {
    it(`flags removing ${label}`, () => {
      const result = check(file(assertion), file(""));
      expect(result.flagged).toBe(true);
      expect(result.findings[0]?.reason).toContain("assertion count dropped");
    });
  }
  it("does not flag an unchanged file", () => {
    expect(check(file("assert.equal(1, 1);"), file("assert.equal(1, 1);")).flagged).toBe(false);
  });
  it("does not count assert-looking text in comments or strings", () => {
    const before = file('// assert.equal(1, 1)\n const s = "assert.ok(x)";');
    expect(check(before, file("")).flagged).toBe(false);
  });
  it("still flags removed expect() assertions (existing behaviour)", () => {
    const withExpect = `import { it } from "node:test";\nit("a", () => { expect(1).toBe(1); });\n`;
    expect(check(withExpect, `import { it } from "node:test";\nit("a", () => {});\n`).flagged).toBe(true);
  });
});
