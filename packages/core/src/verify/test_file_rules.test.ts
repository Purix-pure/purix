// The integrity check, the self-heal test lock and test discovery must agree on what a test file is.
// Before, integrity recognised only .test.ts/.test.tsx while discovery ran test/a.ts and a.spec.ts too, so
// weakening an assertion in those files was never checked.
import { describe, it } from "node:test";
import { expect } from "expect";
import { isTestFilePath, checkTestIntegrity } from "./test_integrity.js";
import { isTestPath } from "./test_discovery.js";
import { isPythonTestFilePath } from "./python_test_integrity.js";
import { isPythonTestPath } from "./python_test_discovery.js";
import { compilePatch } from "./compile.js";

const TS_PATHS = ["a.test.ts", "a.test.tsx", "a.spec.ts", "a.spec.js", "test/a.ts", "src/__tests__/a.ts", "a_test.ts", "test-a.ts", "src/a.ts", "src/latest.ts", "README.md"];

describe("TypeScript/JavaScript test-file rule", () => {
  it("is the discovery rule, for every path", () => {
    for (const p of TS_PATHS) expect(isTestFilePath(p)).toBe(isTestPath(p));
  });
  it("now covers .spec files and test/ folders that the old .test.ts-only rule missed", () => {
    expect(isTestFilePath("a.spec.ts")).toBe(true);
    expect(isTestFilePath("test/a.ts")).toBe(true);
    expect(isTestFilePath("src/__tests__/a.ts")).toBe(true);
    expect(isTestFilePath("src/a.ts")).toBe(false);
  });
  it("a weakened assertion in a.spec.ts is flagged once the file is selected as a test", () => {
    const before = [{ path: "a.spec.ts", content: "it('x', () => { expect(a()).toBe(1); expect(b()).toBe(2); });" }];
    const after = [{ path: "a.spec.ts", content: "it('x', () => { expect(a()).toBe(1); });" }];
    const picked = (files: { path: string; content: string }[]) => files.filter((f) => isTestFilePath(f.path));
    const result = checkTestIntegrity(picked(before), picked(after));
    expect(result.flagged).toBe(true);
    expect(result.findings[0]!.reason).toMatch(/assertion count dropped/);
  });
  it("the self-heal test lock now rejects an edit to a spec file or a file in test/", () => {
    for (const path of ["a.spec.ts", "test/a.ts"]) {
      const out = compilePatch(
        { operation: "update_prompt_text", edits: [{ kind: "prompt_text", path, anchor: "x", replacement: "y" }] } as any,
        [{ path, content: "x" }],
        { blockTestFileEdits: true }
      );
      expect(out.ok).toBe(false);
      expect((out as { reason: string }).reason).toMatch(/TESTLOCK/);
    }
  });
});

describe("Python test-file rule", () => {
  it("is the discovery rule", () => {
    for (const p of ["test_a.py", "a_test.py", "tests/a.py", "conftest.py", "a.py", "latest_report.py", "src/contest.py"]) {
      expect(isPythonTestFilePath(p)).toBe(isPythonTestPath(p));
    }
  });
  it("no longer treats any path containing 'test_' or '_test' as a test", () => {
    expect(isPythonTestFilePath("latest_report.py")).toBe(false);
    expect(isPythonTestFilePath("src/protest_utils.py")).toBe(false);
    expect(isPythonTestFilePath("tests/test_a.py")).toBe(true);
  });
});
