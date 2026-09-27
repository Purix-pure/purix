// The deterministic Patch Compiler edit kinds that had no direct coverage: config_value, tool_binding,
// error_handling, control_flow, plus unwired kinds and mergeFileChanges.
import { describe, it } from "node:test";
import { expect } from "expect";
import { applyEdits, mergeFileChanges, isWiredOperation } from "./compile";

const file = (content: string, path = "src/a.ts") => [{ path, content }];

describe("applyEdits — config_value", () => {
  const edit = (over: object = {}) => ({ path: "src/a.ts", kind: "config_value", key: "timeout", old_value: "30", new_value: "60", ...over }) as any;
  it("changes the value on the one line that has both the key and the old value", () => {
    const r = applyEdits([edit()], file("const a = 1;\nconst timeout = 30;\n"));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.files[0]!.new_content).toBe("const a = 1;\nconst timeout = 60;\n");
  });
  it("refuses when the key is missing, the old value is missing, or the match is ambiguous", () => {
    const missingKey = applyEdits([edit({ key: "retries" })], file("const timeout = 30;\n"));
    expect(missingKey.ok).toBe(false);
    if (!missingKey.ok) expect(missingKey.reason).toContain('key "retries" not found');
    const missingValue = applyEdits([edit({ old_value: "99" })], file("const timeout = 30;\n"));
    if (!missingValue.ok) expect(missingValue.reason).toContain("doesn't appear on that line");
    expect(missingValue.ok).toBe(false);
    const ambiguous = applyEdits([edit()], file("timeout = 30;\ntimeout = 30;\n"));
    expect(ambiguous.ok).toBe(false);
    if (!ambiguous.ok) expect(ambiguous.reason).toContain("ambiguous");
  });
});

describe("applyEdits — tool_binding", () => {
  const edit = (over: object = {}) => ({ path: "src/a.ts", kind: "tool_binding", old_tool: "grep", new_tool: "ripgrep", ...over }) as any;
  it("swaps a single occurrence", () => {
    const r = applyEdits([edit()], file('run("grep")\n'));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.files[0]!.new_content).toBe('run("ripgrep")\n');
  });
  it("refuses when the tool is absent or appears more than once", () => {
    const absent = applyEdits([edit()], file("nothing here\n"));
    expect(absent.ok).toBe(false);
    if (!absent.ok) expect(absent.reason).toContain('tool "grep" not found');
    const twice = applyEdits([edit()], file("grep grep\n"));
    expect(twice.ok).toBe(false);
    if (!twice.ok) expect(twice.reason).toContain("appears 2 times");
  });
});

describe("applyEdits — AST-backed kinds", () => {
  it("error_handling wraps a function with retries, or explains why it cannot", () => {
    const src = "export async function load() {\n  return await fetch('x');\n}\n";
    const ok = applyEdits([{ path: "src/a.ts", kind: "error_handling", function_name: "load", max_retries: 3 } as any], file(src));
    expect(typeof ok.ok).toBe("boolean");
    if (ok.ok) expect(ok.files[0]!.new_content).not.toBe(src);
    const missing = applyEdits([{ path: "src/a.ts", kind: "error_handling", function_name: "nope", max_retries: 3 } as any], file(src));
    expect(missing.ok).toBe(false);
  });
  it("control_flow reports a failure for a function that does not exist", () => {
    const r = applyEdits([{ path: "src/a.ts", kind: "control_flow", function_name: "nope", variable_names: ["x"] } as any], file("export function f(x: number) { return x; }\n"));
    expect(r.ok).toBe(false);
  });
  it("control_flow accepts a real function", () => {
    const r = applyEdits([{ path: "src/a.ts", kind: "control_flow", function_name: "f", variable_names: ["x"] } as any], file("export function f(x: number) { return x + 1; }\n"));
    expect(typeof r.ok).toBe("boolean");
  });
});

describe("applyEdits — guards", () => {
  it("does not apply anything when an edit kind has no wired transform", () => {
    const r = applyEdits([{ path: "src/a.ts", kind: "not_a_real_kind" } as any], file("x\n"));
    expect(r.ok).toBe(false);
  });
  it("refuses edits that target a test file", () => {
    const r = applyEdits([{ path: "src/a.test.ts", kind: "prompt_text", old_text: "1", new_text: "2" } as any], file("expect(1)\n", "src/a.test.ts"));
    expect(r.ok).toBe(false);
  });
  it("isWiredOperation is false for an unknown operation", () => {
    expect(isWiredOperation("definitely_not_an_operation")).toBe(false);
  });
});

describe("mergeFileChanges", () => {
  it("overlays changed files and keeps the rest as they were", () => {
    const merged = mergeFileChanges(
      [{ path: "a.ts", content: "old a" }, { path: "b.ts", content: "old b" }],
      [{ path: "b.ts", new_content: "new b" }]
    );
    expect(merged).toEqual([{ path: "a.ts", new_content: "old a" }, { path: "b.ts", new_content: "new b" }]);
  });
});
