// src/verify/ast_transforms_eol.test.ts
//
// H4 / research 04 finding 5: on a CRLF file both AST transforms returned almost every line with a bare LF (the library rewrites inserted
// text to its own newline style, LF by default), so the file came back with mixed endings; and `change_control_flow` printed
// `return [x, y];}` with the closing brace on the last statement's line. Both reproduced with a probe before these tests were written.
// Not covered here: the transforms still check names, not behaviour (F04-05), and they do not re-indent the wrapped body.
import { describe, it } from "node:test";
import { expect } from "expect";
import { applyErrorHandlingTransform, applyControlFlowTransform } from "./ast_transforms";

const LF = "export async function run(a: number) {\n  const x = await f(a);\n  const y = await g(a);\n  return [x, y];\n}\n";
const CRLF = LF.replace(/\n/g, "\r\n");
const bareLf = (s: string) => (s.match(/(?<!\r)\n/g) ?? []).length;
const crlf = (s: string) => (s.match(/\r\n/g) ?? []).length;

describe("AST transforms keep the file's line endings", () => {
  it("add_error_handling on a CRLF file writes no bare LF", () => {
    const r = applyErrorHandlingTransform(CRLF, "a.ts", "run", 3);
    expect(r.ok).toBe(true);
    if (r.ok) { expect(bareLf(r.content)).toBe(0); expect(crlf(r.content)).toBeGreaterThan(5); }
  });
  it("change_control_flow on a CRLF file writes no bare LF", () => {
    const r = applyControlFlowTransform(CRLF, "a.ts", "run", ["x", "y"]);
    expect(r.ok).toBe(true);
    if (r.ok) { expect(bareLf(r.content)).toBe(0); expect(crlf(r.content)).toBeGreaterThan(3); }
  });
  it("an LF file stays LF in both transforms", () => {
    const a = applyErrorHandlingTransform(LF, "a.ts", "run", 3);
    const b = applyControlFlowTransform(LF, "a.ts", "run", ["x", "y"]);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) { expect(crlf(a.content)).toBe(0); expect(crlf(b.content)).toBe(0); }
  });
});

describe("change_control_flow keeps the closing brace on its own line", () => {
  it("does not join the closing brace to the last statement", () => {
    const r = applyControlFlowTransform(LF, "a.ts", "run", ["x", "y"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.content).toBe("export async function run(a: number) {\n  const [x, y] = await Promise.all([f(a), g(a)]);\n  return [x, y];\n}\n");
  });
  it("same on CRLF", () => {
    const r = applyControlFlowTransform(CRLF, "a.ts", "run", ["x", "y"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.content).toBe("export async function run(a: number) {\r\n  const [x, y] = await Promise.all([f(a), g(a)]);\r\n  return [x, y];\r\n}\r\n");
  });
});
