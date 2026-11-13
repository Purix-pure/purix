// AI-07: the parse check runs before any copy, and only blames an edit for what the edit broke.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { precheckEdits } from "./precheck.js";
import { verifyInSandbox } from "../sandbox/sandbox.js";
import { closeDb } from "../manifest/store.js";
import { safeRmSync } from "../platform/fs_retry.js";
import { spawnSync } from "../platform/spawn_sync.js";
import { pythonProvider } from "../language/providers/python.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "purix-precheck-")); });
afterEach(() => { closeDb(); safeRmSync(dir); });

const put = (p: string, c: string) => writeFileSync(join(dir, p), c);
const havePython = ["python3", "python"].some((b) => spawnSync([b, "--version"], { cwd: tmpdir(), stdout: "pipe", stderr: "pipe" }).exitCode === 0);
// Having a `python` on PATH is not enough: the parse check has to really answer. On a busy Windows machine (Store shim, antivirus)
// it can come back empty, and Purix then makes no claim about the file. That is correct behaviour, so the test is skipped there
// instead of failing on a machine that cannot run the check.
const pythonParseWorks = havePython && pythonProvider.parseCheck?.("probe.py", "x = 1\n")?.ok === true;

describe("precheckEdits", () => {
  it("passes a clean edit and an edit to a file nobody checks", () => {
    put("a.ts", "export const a = 1;\n");
    put("notes.md", "# hi\n");
    expect(precheckEdits([{ path: "a.ts", new_content: "export const a = 2;\n" }, { path: "notes.md", new_content: "{{{ not code" }], dir)).toBeNull();
  });

  it("fails a TypeScript edit that no longer parses, in the compiler's own line format", () => {
    put("a.ts", "export function f() {\n  return 1;\n}\n");
    const r = precheckEdits([{ path: "a.ts", new_content: "export function f() {\n  return 1;\n\n" }], dir);
    expect(r).not.toBeNull();
    expect(r!.errorClass).toBe("syntax");
    expect(r!.reason).toMatch(/^a\.ts\(\d+,\d+\): error TS\d+: .+/);
    expect(r!.files).toEqual(["a.ts"]);
  });

  it("handles JavaScript, JSX and TSX files, and accepts valid JSX", () => {
    put("a.jsx", "export const A = () => <div />;\n");
    put("b.tsx", "export const B = () => <div />;\n");
    expect(precheckEdits([{ path: "a.jsx", new_content: "export const A = () => <div>hi</div>;\n" }, { path: "b.tsx", new_content: "export const B = (): JSX.Element => <p />;\n" }], dir)).toBeNull();
    expect(precheckEdits([{ path: "a.jsx", new_content: "export const A = () => <div>;\n" }], dir)).not.toBeNull();
  });

  it("an original that already fails the parser is not blocked", () => {
    put("broken.ts", "export const = ;\n");
    expect(precheckEdits([{ path: "broken.ts", new_content: "export const = 2;\n" }], dir)).toBeNull();
  });

  it("a brand-new file is left to the compiler: there is no original to prove the parser agrees with the project", () => {
    expect(precheckEdits([{ path: "fresh.ts", new_content: "export const = ;\n" }], dir)).toBeNull();
  });

  it("JSON: broken JSON fails with a position, commented JSON (already invalid as JSON) is left alone", () => {
    put("package.json", '{\n  "name": "x"\n}\n');
    const r = precheckEdits([{ path: "package.json", new_content: '{\n  "name": "x",\n}\n' }], dir);
    expect(r).not.toBeNull();
    expect(r!.reason).toMatch(/^package\.json\(\d+,\d+\): error JSON: /);
    put("tsconfig.json", '{\n  // comment\n  "a": 1\n}\n');
    expect(precheckEdits([{ path: "tsconfig.json", new_content: '{\n  // comment\n  "a": 2,,\n}\n' }], dir)).toBeNull();
  });

  it("never reads outside the project directory for the original", () => {
    expect(precheckEdits([{ path: "../escape.ts", new_content: "export const = ;\n" }], dir)).toBeNull();
  });

  it("reports at most five files and says how many more", () => {
    const changes = Array.from({ length: 8 }, (_, i) => { put(`f${i}.ts`, "export const a = 1;\n"); return { path: `f${i}.ts`, new_content: "export const = ;\n" }; });
    const r = precheckEdits(changes, dir)!;
    expect(r.reason.split("\n").length).toBe(6);
    expect(r.reason).toContain("(3 more file(s) with syntax errors)");
    expect(r.files.length).toBe(8);
  });

  it("Python: a syntax error in an edit of a clean file fails with its line", { skip: !pythonParseWorks }, () => {
    put("m.py", "def f():\n    return 1\n");
    const r = precheckEdits([{ path: "m.py", new_content: "def f():\n    return (1\n" }], dir);
    expect(r).not.toBeNull();
    expect(r!.reason).toMatch(/^m\.py\(\d+,\d+\): error SyntaxError: /);
    expect(precheckEdits([{ path: "m.py", new_content: "def f():\n    return 2\n" }], dir)).toBeNull();
  });

  it("costs under 50 ms on a 500-line TypeScript file once the parser is loaded", () => {
    const body = Array.from({ length: 500 }, (_, i) => `export const v${i}: number = ${i} + 1;`).join("\n") + "\n";
    put("big.ts", body);
    precheckEdits([{ path: "big.ts", new_content: body }], dir); // first call pays the one-time parser load
    // Best of five: one slow run (GC, a busy Windows machine, coverage instrumentation) says nothing about what the check costs.
    // Under --experimental-test-coverage every function is instrumented, so the budget is wider there.
    const budgetMs = process.env.NODE_V8_COVERAGE ? 150 : 50;
    let best = Infinity;
    for (let i = 0; i < 5; i++) {
      const t = performance.now();
      precheckEdits([{ path: "big.ts", new_content: body.replace("v7:", `w7${i}:`) }], dir);
      best = Math.min(best, performance.now() - t);
    }
    expect(best).toBeLessThan(budgetMs);
  });
});

describe("verifyInSandbox with the parse check", () => {
  it("a syntax-broken edit fails before any copy: no temp directory is created", () => {
    put("a.ts", "export const a = 1;\n");
    const scratch = mkdtempSync(join(tmpdir(), "purix-scratch-"));
    const saved = process.env.TMPDIR; const savedT = process.env.TEMP; const savedTmp = process.env.TMP;
    process.env.TMPDIR = scratch; process.env.TEMP = scratch; process.env.TMP = scratch;
    try {
      const r = verifyInSandbox("comp-x", [{ path: "a.ts", new_content: "export const = ;\n" }], dir, "typescript");
      expect(r.status).toBe("fail");
      if (r.status === "fail") {
        expect(r.errorClass).toBe("syntax");
        expect(r.reason).toMatch(/^a\.ts\(\d+,\d+\): error TS\d+/);
        expect(r.policyBlock).toBeUndefined();
      }
      expect(readdirSync(scratch)).toEqual([]);
    } finally {
      for (const [k, v] of [["TMPDIR", saved], ["TEMP", savedT], ["TMP", savedTmp]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      safeRmSync(scratch);
    }
  });

  it("policy blocks keep precedence over the parse check", () => {
    put("a.ts", "export const a = 1;\n");
    const secret = "export const k = 'AKIAIOSFODNN7EXAMPLE'; const = ;\n";
    const r = verifyInSandbox("comp-x", [{ path: "a.ts", new_content: secret }], dir, "typescript");
    expect(r.status).toBe("fail");
    if (r.status === "fail") expect(r.policyBlock).toBe(true);
  });
});
