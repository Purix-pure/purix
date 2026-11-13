// A1 regression (plan blocker 6): the repair test lock knew only JavaScript names, so a repair could rewrite a Python assertion
// or empty a runner's include list without the lock noticing.
import { describe, it } from "node:test";
import { expect } from "expect";
import { compilePatch } from "./compile.js";
import { isProtectedTestPath, testFileRulesOf, BUILTIN_TEST_FILE_RULES } from "../language/provider-kit.js";

function edit(path: string, oldText: string, newText: string) {
  return compilePatch(
    { operation: "update_prompt_text", edits: [{ kind: "prompt_text", path, old_text: oldText, new_text: newText }] } as never,
    [{ path, content: `x = 1\n${oldText}\n` }],
    { blockTestFileEdits: true },
  );
}
const rejected = (r: ReturnType<typeof edit>) => !r.ok && /TESTLOCK/.test((r as { reason: string }).reason);

describe("repair test lock covers every registered language", () => {
  const locked = [
    ["Python assertion rewritten", "tests/test_a.py", "assert x == 1", "assert True"],
    ["Python test at the root", "test_a.py", "assert x == 1", "assert True"],
    ["Python _test suffix", "pkg/a_test.py", "assert x == 1", "assert True"],
    ["pytest helper", "conftest.py", "assert x == 1", "assert True"],
    ["Vitest include list emptied", "vitest.config.ts", "include: ['src/**/*.test.ts']", "include: []"],
    ["Jest config", "jest.config.js", "testMatch: ['a']", "testMatch: []"],
    ["pytest.ini", "pytest.ini", "testpaths = tests", "testpaths ="],
    ["TypeScript test in a plural tests/ folder", "tests/a.ts", "expect(1).toBe(1)", "expect(1).toBe(2)"],
    ["snapshot file", "src/__snapshots__/a.test.ts.snap", "exports[`a`] = `1`", "exports[`a`] = `2`"],
    ["Windows separators", "tests\\test_a.py", "assert x == 1", "assert True"],
    ["upper-case name on a case-insensitive disk", "Tests/Test_A.py", "assert x == 1", "assert True"],
    ["existing JS rule still holds", "a.test.ts", "expect(1).toBe(1)", "expect(1).toBe(2)"],
  ] as const;
  for (const [label, path, from, to] of locked) it(`rejects: ${label}`, () => expect(rejected(edit(path, from, to))).toBe(true));

  it("does not reject an ordinary source file", () => {
    expect(rejected(edit("src/app.py", "x = 1", "x = 2"))).toBe(false);
    expect(rejected(edit("src/contest.py", "x = 1", "x = 2"))).toBe(false);
  });
  it("does not block the whole of pyproject.toml or package.json (mixed files; needs a content check, A6)", () => {
    expect(rejected(edit("pyproject.toml", "x = 1", "x = 2"))).toBe(false);
    expect(rejected(edit("package.json", "x = 1", "x = 2"))).toBe(false);
  });
  it("the check is off unless blockTestFileEdits is set", () => {
    const r = compilePatch({ operation: "update_prompt_text", edits: [{ kind: "prompt_text", path: "tests/test_a.py", old_text: "assert x == 1", new_text: "assert True" }] } as never, [{ path: "tests/test_a.py", content: "x = 1\nassert x == 1\n" }], {});
    expect(rejected(r)).toBe(false);
  });
});

describe("provider test rules", () => {
  it("a provider's own members win over the transitional table", () => {
    const rules = testFileRulesOf({ id: "python", isTestFile: (p) => p === "only-this.py", testConfigPaths: [] });
    expect(rules.isTestFile!("tests/test_a.py")).toBe(false);
    expect(rules.isTestFile!("only-this.py")).toBe(true);
    expect(isProtectedTestPath("tests/test_a.py", [{ id: "python", isTestFile: (p) => p === "only-this.py", testConfigPaths: [] }])).toBe(false);
  });
  it("an unknown language with no rule protects nothing", () => {
    expect(isProtectedTestPath("a_test.go", [{ id: "go" }])).toBe(false);
  });
  it("a new language can protect its own files without the table", () => {
    expect(isProtectedTestPath("pkg/a_test.go", [{ id: "go", isTestFile: (p) => p.endsWith("_test.go") }])).toBe(true);
    expect(isProtectedTestPath("go.work", [{ id: "go", testConfigPaths: ["go.work"] }])).toBe(true);
  });
  it("the table covers exactly the two built-in languages", () => {
    expect(Object.keys(BUILTIN_TEST_FILE_RULES).sort()).toEqual(["python", "typescript"]);
  });
});
