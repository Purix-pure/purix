// src/verify/ast_transforms.test.ts
//
// These two transforms are the actual code-modification engine on the
// deterministic path — no LLM in the loop, so their failure mode is
// "silently produces wrong code" rather than "obviously errors out."
// Coverage here leans on the documented fail-closed guarantees: ambiguous
// targets, non-async functions, double-wrapping, real dependencies between
// statements, and non-contiguous selections should all refuse rather than
// guess.
import { describe, it } from "node:test";
import { expect } from "expect";
import { applyErrorHandlingTransform, applyControlFlowTransform } from "./ast_transforms";

describe("applyErrorHandlingTransform", () => {
  const SIMPLE_FN = `
async function fetchData() {
  const res = await fetch("https://example.com");
  return res.json();
}
`;

  it("wraps a simple async function body in a capped retry loop", () => {
    const result = applyErrorHandlingTransform(SIMPLE_FN, "a.ts", "fetchData", 3);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content).toContain("__purix_attempt <= 3");
      expect(result.content).toContain("try {");
      expect(result.content).toContain('await fetch("https://example.com")');
    }
  });

  it("works on a const-assigned async arrow function, not just a function declaration", () => {
    const src = `
const fetchData = async () => {
  const res = await fetch("https://example.com");
  return res.json();
};
`;
    const result = applyErrorHandlingTransform(src, "a.ts", "fetchData", 2);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.content).toContain("__purix_attempt <= 2");
  });

  it("rejects a non-integer max_retries", () => {
    const result = applyErrorHandlingTransform(SIMPLE_FN, "a.ts", "fetchData", 2.5);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/integer between 1 and 10/);
  });

  it("rejects max_retries below 1", () => {
    const result = applyErrorHandlingTransform(SIMPLE_FN, "a.ts", "fetchData", 0);
    expect(result.ok).toBe(false);
  });

  it("rejects max_retries above 10", () => {
    const result = applyErrorHandlingTransform(SIMPLE_FN, "a.ts", "fetchData", 11);
    expect(result.ok).toBe(false);
  });

  it("rejects targeting a function that doesn't exist", () => {
    const result = applyErrorHandlingTransform(SIMPLE_FN, "a.ts", "doesNotExist", 3);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/no top-level function/);
  });

  it("rejects targeting a non-async function", () => {
    const src = `function syncFn() { return 1; }`;
    const result = applyErrorHandlingTransform(src, "a.ts", "syncFn", 3);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/isn't async/);
  });

  it("rejects an ambiguous target with two top-level definitions sharing a name", () => {
    // A same-named function nested inside another scope shouldn't count as
    // a second top-level match, but two genuinely top-level ones should.
    const src = `
async function dup() { return 1; }
const dup = async () => { return 2; };
`;
    const result = applyErrorHandlingTransform(src, "a.ts", "dup", 3);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/ambiguous/);
  });

  it("does not confuse a same-named function nested inside another function for a top-level match", () => {
    const src = `
async function outer() {
  async function inner() { return "shadowed"; }
  return inner();
}
`;
    // Only "outer" is top-level; this should succeed cleanly against outer,
    // not error out claiming ambiguity with the nested "inner"-shadowed name.
    const result = applyErrorHandlingTransform(src, "a.ts", "outer", 3);
    expect(result.ok).toBe(true);
  });

  it("rejects a function with an empty body", () => {
    const src = `async function empty() {}`;
    const result = applyErrorHandlingTransform(src, "a.ts", "empty", 3);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/empty body/);
  });

  it("refuses to double-wrap a function that already has a top-level try/catch", () => {
    const src = `
async function fn() {
  try {
    return await doWork();
  } catch (e) {
    throw e;
  }
}
`;
    const result = applyErrorHandlingTransform(src, "a.ts", "fn", 3);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/already has a top-level try\/catch/);
  });

  it("refuses to double-wrap a function that already has a Purix-generated retry wrapper", () => {
    const first = applyErrorHandlingTransform(SIMPLE_FN, "a.ts", "fetchData", 3);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = applyErrorHandlingTransform(first.content, "a.ts", "fetchData", 3);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toMatch(/already has a Purix-generated retry wrapper/);
  });

  it("rejects a concise (non-block) async arrow body", () => {
    const src = `const fn = async () => doWork();`;
    const result = applyErrorHandlingTransform(src, "a.ts", "fn", 3);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/concise \(non-block\) arrow body/);
  });

  it("fails gracefully (does not throw) on unparseable content", () => {
    expect(() => applyErrorHandlingTransform("{{{ not valid ts (((", "a.ts", "fn", 3)).not.toThrow();
  });
});

describe("applyControlFlowTransform", () => {
  const SEQUENTIAL_FN = `
async function loadAll() {
  const a = await fetchA();
  const b = await fetchB();
  const c = await fetchC();
  return a + b + c;
}
`;

  it("merges two adjacent independent await statements into Promise.all", () => {
    const result = applyControlFlowTransform(SEQUENTIAL_FN, "a.ts", "loadAll", ["a", "b"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content).toContain("const [a, b] = await Promise.all([fetchA(), fetchB()]);");
      // The untouched third statement should still be present afterward.
      expect(result.content).toContain("const c = await fetchC();");
    }
  });

  it("merges all three when all three are requested", () => {
    const result = applyControlFlowTransform(SEQUENTIAL_FN, "a.ts", "loadAll", ["a", "b", "c"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content).toContain("await Promise.all([fetchA(), fetchB(), fetchC()])");
    }
  });

  it("rejects fewer than 2 distinct variable names", () => {
    const result = applyControlFlowTransform(SEQUENTIAL_FN, "a.ts", "loadAll", ["a"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/at least 2 distinct variable names/);
  });

  it("treats duplicate names in the input as a single name and still rejects if that leaves fewer than 2", () => {
    const result = applyControlFlowTransform(SEQUENTIAL_FN, "a.ts", "loadAll", ["a", "a"]);
    expect(result.ok).toBe(false);
  });

  it("rejects a variable name that isn't a simple top-level await declaration", () => {
    const result = applyControlFlowTransform(SEQUENTIAL_FN, "a.ts", "loadAll", ["a", "doesNotExist"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/refusing to guess how to parallelize/);
  });

  it("rejects non-contiguous statements — something else sits between them", () => {
    const src = `
async function loadAll() {
  const a = await fetchA();
  console.log("side effect");
  const b = await fetchB();
  return a + b;
}
`;
    const result = applyControlFlowTransform(src, "a.ts", "loadAll", ["a", "b"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/aren't contiguous/);
  });

  it("refuses to parallelize when one statement genuinely depends on another", () => {
    const src = `
async function loadAll() {
  const a = await fetchA();
  const b = await fetchB(a);
  return a + b;
}
`;
    const result = applyControlFlowTransform(src, "a.ts", "loadAll", ["a", "b"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/sequential dependency/);
  });

  it("rejects targeting a function that doesn't exist", () => {
    const result = applyControlFlowTransform(SEQUENTIAL_FN, "a.ts", "doesNotExist", ["a", "b"]);
    expect(result.ok).toBe(false);
  });

  it("uses 'let' instead of 'const' if any selected declaration was originally 'let'", () => {
    const src = `
async function loadAll() {
  let a = await fetchA();
  const b = await fetchB();
  return a + b;
}
`;
    const result = applyControlFlowTransform(src, "a.ts", "loadAll", ["a", "b"]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.content).toContain("let [a, b] = await Promise.all(");
  });

  it("preserves statement order in the merged Promise.all regardless of the order variable names were requested in", () => {
    const result = applyControlFlowTransform(SEQUENTIAL_FN, "a.ts", "loadAll", ["b", "a"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Statements are ordered by their original position (a before b),
      // not by the order they were passed in the request.
      expect(result.content).toContain("const [a, b] = await Promise.all([fetchA(), fetchB()]);");
    }
  });

  it("fails gracefully (does not throw) on unparseable content", () => {
    expect(() =>
      applyControlFlowTransform("{{{ not valid ts (((", "a.ts", "fn", ["a", "b"])
    ).not.toThrow();
  });
});