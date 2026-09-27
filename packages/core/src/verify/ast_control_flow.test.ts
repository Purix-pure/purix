// applyControlFlowTransform(): every refusal branch plus the let/const and skipped-declaration cases.
import { describe, it } from "node:test";
import { expect } from "expect";
import { applyControlFlowTransform } from "./ast_transforms";

const src = (body: string) => `export async function run() {\n${body}\n}\n`;
const run = (body: string, names: string[], fn = "run") => applyControlFlowTransform(src(body), "a.ts", fn, names);
const reasonOf = (r: { ok: boolean; reason?: string }) => (r.ok ? "" : (r.reason ?? ""));

describe("applyControlFlowTransform", () => {
  it("parallelizes two adjacent independent awaits into one Promise.all", () => {
    const r = run("  const a = await f();\n  const b = await g();\n  return [a, b];", ["a", "b"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.content).toContain("const [a, b] = await Promise.all([f(), g()]);");
  });
  it("uses let for the merged declaration when any original was let", () => {
    const r = run("  let a = await f();\n  const b = await g();\n  return [a, b];", ["a", "b"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.content).toContain("let [a, b] = await Promise.all([f(), g()]);");
  });
  it("needs at least two distinct names", () => {
    expect(reasonOf(run("  const a = await f();", ["a"]))).toContain("at least 2 distinct");
    expect(reasonOf(run("  const a = await f();", ["a", "a"]))).toContain("at least 2 distinct");
  });
  it("refuses a name that is not a simple top-level await declaration", () => {
    expect(reasonOf(run("  const a = await f();\n  const b = 5;", ["a", "b"]))).toContain("isn't a simple top-level");
    expect(reasonOf(run("  const a = await f();", ["a", "missing"]))).toContain("isn't a simple top-level");
  });
  it("ignores multi-declaration and destructuring statements when collecting candidates", () => {
    const body = "  const x = 1, y = 2;\n  const { p } = await h();\n  const a = await f();\n  const b = await g();";
    const r = run(body, ["a", "b"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.content).toContain("Promise.all([f(), g()])");
    expect(reasonOf(run(body, ["a", "p"]))).toContain("isn't a simple top-level");
  });
  it("refuses statements that are not contiguous", () => {
    expect(reasonOf(run("  const a = await f();\n  log();\n  const b = await g();", ["a", "b"]))).toContain("aren't contiguous");
  });
  it("refuses a real sequential dependency between the selected statements", () => {
    expect(reasonOf(run("  const a = await f();\n  const b = await g(a);", ["a", "b"]))).toContain("sequential dependency");
  });
  it("fails cleanly when the function does not exist", () => {
    expect(run("  const a = await f();\n  const b = await g();", ["a", "b"], "nope").ok).toBe(false);
  });
});
