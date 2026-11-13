// AI-15a: the general code-change operation. Same text edits as before, on tracked files only, with a size cap.
import { describe, it } from "node:test";
import { expect } from "expect";
import { compilePatch, applyEdits, isWiredOperation } from "./compile.js";
import { checkModifyCodeLimits, changedLines } from "./modify_code.js";
import { OPERATIONS, MODIFY_CODE_MAX_EDITS, MODIFY_CODE_MAX_LINES } from "../llm/prompts/edit_kinds.js";
import type { ChangeEdit, ChangeVerdict } from "../llm/classify.js";

const files = [
  { path: "src/a.ts", content: "export function f(n: number) {\n  if (n > 1) return 1;\n  return 0;\n}\n" },
  { path: "src/a.test.ts", content: "// test\n" },
];
const verdict = (edits: ChangeEdit[], operation = "modify_code"): ChangeVerdict =>
  ({ operation, contract_changing: false, confidence: 0.9, reasoning: "r", edits, suspicious_injected_instruction: false }) as ChangeVerdict;
const pt = (old_text: string, new_text: string, path = "src/a.ts"): ChangeEdit => ({ kind: "prompt_text", path, old_text, new_text });
const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`).join("\n");

describe("modify_code", () => {
  it("is a listed, wired operation", () => {
    expect((OPERATIONS as readonly string[]).includes("modify_code")).toBe(true);
    expect(isWiredOperation("modify_code")).toBe(true);
  });

  it("applies a plain code change through the same compiler as prompt_text", () => {
    const r = compilePatch(verdict([pt("if (n > 1) return 1;", "if (n >= 1) return 1;")]), files);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.files[0]!.new_content).toContain("n >= 1");
  });

  it("still refuses a path that is not one of the component's files", () => {
    const r = compilePatch(verdict([pt("x", "y", "src/other.ts")]), files);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("isn't one of this component's known files");
  });

  it("still refuses an anchor that is not there, loudly", () => {
    const r = compilePatch(verdict([pt("does not exist", "y")]), files);
    expect(r.ok).toBe(false);
  });

  it("allows exactly the maximum number of edits and refuses one more", () => {
    const ok = Array.from({ length: MODIFY_CODE_MAX_EDITS }, () => pt("return 0;", "return 0;"));
    expect(checkModifyCodeLimits(ok)).toBeNull();
    const reason = checkModifyCodeLimits([...ok, pt("a", "b")]);
    expect(reason).toContain(`at most ${MODIFY_CODE_MAX_EDITS} edits`);
    const r = compilePatch(verdict([...ok, pt("a", "b")]), files);
    expect(r.ok).toBe(false);
  });

  it("allows an edit of the maximum size and refuses one line more, counting the larger side", () => {
    expect(changedLines(pt(lines(MODIFY_CODE_MAX_LINES), "x"))).toBe(MODIFY_CODE_MAX_LINES);
    expect(checkModifyCodeLimits([pt(lines(MODIFY_CODE_MAX_LINES), "x")])).toBeNull();
    expect(checkModifyCodeLimits([pt("x", lines(MODIFY_CODE_MAX_LINES))])).toBeNull();
    const big = checkModifyCodeLimits([pt("x", lines(MODIFY_CODE_MAX_LINES + 1))]);
    expect(big).toContain(`at most ${MODIFY_CODE_MAX_LINES} lines`);
    expect(big).toContain("src/a.ts");
  });

  it("does not count a final newline as a line, and counts CRLF text the same as LF", () => {
    expect(changedLines(pt(`${lines(3)}\n`, "x"))).toBe(3);
    expect(changedLines(pt(lines(3).replace(/\n/g, "\r\n"), "x"))).toBe(3);
    expect(changedLines(pt("", ""))).toBe(0);
  });

  it("refuses the AST edit kinds under modify_code, naming the kind", () => {
    const eh: ChangeEdit = { kind: "error_handling", path: "src/a.ts", function_name: "f", max_retries: 3 };
    const r = compilePatch(verdict([eh]), files);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('"error_handling"');
  });

  it("the size rules apply only to modify_code: the named operations behave as before", () => {
    // A3-2: an edit that changes nothing is now refused, so the many edits are a chain of real ones (a marker comment renamed m0, m1, m2 ...).
    const many = Array.from({ length: MODIFY_CODE_MAX_EDITS + 3 }, (_, i) => (i === 0 ? pt("return 0;", "return 0; // m0") : pt(`// m${i - 1}`, `// m${i}`)));
    expect(compilePatch(verdict(many, "update_prompt_text"), files).ok).toBe(true);
    const big = compilePatch(verdict([pt("return 0;", lines(MODIFY_CODE_MAX_LINES + 10))], "update_prompt_text"), files);
    expect(big.ok).toBe(true);
  });

  it("an empty edit list is still refused, as for every operation", () => {
    const r = compilePatch(verdict([]), files);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("classifier returned no edits to apply");
  });

  it("the test-file lock of the repair loop is unchanged", () => {
    const r = compilePatch(verdict([pt("// test", "// changed", "src/a.test.ts")]), files, { blockTestFileEdits: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("§E-TESTLOCK");
    // A direct human instruction may still change a test file.
    expect(compilePatch(verdict([pt("// test", "// changed", "src/a.test.ts")]), files).ok).toBe(true);
    // And the repair-loop entry point never sees the new operation: it maps edit kinds, not operations.
    expect(applyEdits([pt("return 0;", "return 1;")], files).ok).toBe(true);
  });

  it("every operation in the taxonomy is either wired or one of the two documented exceptions", () => {
    const unwired = (OPERATIONS as readonly string[]).filter((o) => !isWiredOperation(o)).sort();
    expect(unwired).toEqual(["add_memory_scope", "unclassified"]);
  });
});
