// src/verify/ast_transforms_edges.test.ts
// H4 (research 04 finding F04-05, formatting half): the two AST transforms must keep the file's line endings and must leave the
// function's closing brace on its own line. Both were reproduced against the unfixed code: a CRLF file came back with one CRLF
// and a dozen bare LFs, and `return [a, b];}` was printed on one line. (What the transforms do NOT check, behaviour, is a
// separate open finding and is not touched here.)
import { describe, it } from "node:test";
import { expect } from "expect";
import { applyControlFlowTransform, applyErrorHandlingTransform } from "./ast_transforms";

const lf = (s: string): string => s;
const crlf = (s: string): string => s.replace(/\n/g, "\r\n");
const bareLf = (s: string): number => (s.match(/(?<!\r)\n/g) ?? []).length;
const crCount = (s: string): number => (s.match(/\r/g) ?? []).length;

const flow = `async function run(db: any) {\n  const a = await db.one();\n  const b = await db.two();\n  return [a, b];\n}\n`;
const retry = `async function save(db: any) {\n  await db.put(1);\n  await db.put(2);\n}\n`;

function content(r: { ok: boolean; content?: string; reason?: string }): string {
  if (!r.ok) throw new Error(r.reason);
  return r.content as string;
}

describe("control-flow transform", () => {
  it("keeps CRLF line endings: no bare LF in the result", () => {
    const out = content(applyControlFlowTransform(crlf(flow), "a.ts", "run", ["a", "b"]));
    expect(bareLf(out)).toBe(0);
    expect(out).toContain("Promise.all");
  });
  it("keeps LF line endings: no CR in the result", () => {
    const out = content(applyControlFlowTransform(lf(flow), "a.ts", "run", ["a", "b"]));
    expect(crCount(out)).toBe(0);
  });
  it("leaves the closing brace on its own line", () => {
    const out = content(applyControlFlowTransform(lf(flow), "a.ts", "run", ["a", "b"]));
    expect(out).toBe(`async function run(db: any) {\n  const [a, b] = await Promise.all([db.one(), db.two()]);\n  return [a, b];\n}\n`);
  });
});

describe("error-handling transform", () => {
  it("keeps CRLF line endings: no bare LF in the result", () => {
    const out = content(applyErrorHandlingTransform(crlf(retry), "a.ts", "save", 3));
    expect(bareLf(out)).toBe(0);
    expect(out).toContain("__purix_attempt");
  });
  it("keeps LF line endings: no CR in the result", () => {
    const out = content(applyErrorHandlingTransform(lf(retry), "a.ts", "save", 3));
    expect(crCount(out)).toBe(0);
  });
});
