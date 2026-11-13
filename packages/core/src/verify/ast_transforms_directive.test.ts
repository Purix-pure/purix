// F04-05 (part): a leading directive such as "use server" must stay the first statement of the function. Wrapping it inside the
// retry block turns it into an ordinary string statement and the directive stops working.
import { describe, it } from "node:test";
import { expect } from "expect";
import { applyErrorHandlingTransform } from "./ast_transforms";

describe("add_error_handling keeps a leading directive in place", () => {
  it("leaves \"use server\" before the retry loop", () => {
    const src = `export async function pay(id: string) {\n  "use server";\n  await charge(id);\n}\n`;
    const r = applyErrorHandlingTransform(src, "a.ts", "pay", 3);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const loopAt = r.content.indexOf("for (let __purix_attempt");
    const dirAt = r.content.indexOf('"use server"');
    expect(dirAt).toBeGreaterThan(-1);
    expect(dirAt).toBeLessThan(loopAt);
    expect(r.content.match(/"use server"/g)?.length).toBe(1);
    // the directive is not inside the try block
    expect(r.content.slice(r.content.indexOf("try {"))).not.toContain('"use server"');
  });

  it("refuses a body that is only directives", () => {
    const src = `export async function f() {\n  "use server";\n}\n`;
    const r = applyErrorHandlingTransform(src, "a.ts", "f", 3);
    expect(r.ok).toBe(false);
  });

  it("a function with no directive is wrapped as before", () => {
    const src = `export async function g() {\n  await work();\n}\n`;
    const r = applyErrorHandlingTransform(src, "a.ts", "g", 2);
    expect(r.ok).toBe(true);
  });
});
