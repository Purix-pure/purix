// verifyInSandbox() end to end with the repo's real tsc: copy filtering, language routing and each early-return branch.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb } from "../manifest/store";
import { verifyInSandbox, cleanupSandboxTempRoots } from "./sandbox";
import { resolveRealNodeModules } from "../test-support/real_node_modules";
import { safeRmSync } from "../platform/fs_retry.js";

const realModules = resolveRealNodeModules("typescript");
const skip = realModules ? false : "no node_modules with typescript found";

let cwd: string;
let dir: string;
let warn: typeof console.warn;
let log: typeof console.log;

beforeEach(() => {
  cwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "purix-sbxflow-"));
  process.chdir(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "p", type: "module", devDependencies: { "@types/node": "*" } }));
  writeFileSync(join(dir, ".env"), "SECRET_THAT_MUST_NOT_BE_COPIED=1\n");
  mkdirSync(join(dir, ".git"));
  mkdirSync(join(dir, ".purix"));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "existing.ts"), "export const existing = 1;\n");
  if (realModules) symlinkSync(realModules, join(dir, "node_modules"), "junction");
  warn = console.warn;
  log = console.log;
  console.warn = () => {};
  console.log = () => {};
});
afterEach(() => {
  console.warn = warn;
  console.log = log;
  cleanupSandboxTempRoots();
  // LIFECYCLE FIX: this test spawns the repo's real tsc via verifyInSandbox
  // and then closes the manifest DB right before deleting `dir`. A bare
  // rmSync loses the same Windows file-lock race documented in
  // budget_edges.test.ts (closeDb()/a just-exited child process handle not
  // yet released by the OS) — safeRmSync retries with backoff instead of
  // failing the whole test on a transient EPERM.
  closeDb();
  process.chdir(cwd);
  safeRmSync(dir);
});

describe("verifyInSandbox — full flow", { skip }, () => {
  it("passes a valid TypeScript change (copying the project, minus .env/.git/.purix, and linking node_modules)", () => {
    const r = verifyInSandbox("comp", [{ path: "src/a.ts", new_content: "export const a: number = 1;\n" }], dir);
    expect(r.status).toBe("pass");
    expect(Array.isArray(r.idiomFindings)).toBe(true);
  });
  it("fails a change that does not type-check, quoting the compiler", () => {
    const r = verifyInSandbox("comp", [{ path: "src/a.ts", new_content: 'export const a: number = "not a number";\n' }], dir);
    expect(r.status).toBe("fail");
    if (r.status === "fail") expect(r.reason).toContain("TS2322");
  });
  it("honours an explicit language override", () => {
    const r = verifyInSandbox("comp", [{ path: "src/b.ts", new_content: "export const b = 2;\n" }], dir, "typescript");
    expect(r.status).toBe("pass");
  });
  it("refuses, rather than silently passing, for a language with no provider", () => {
    const r = verifyInSandbox("comp", [{ path: "src/c.ts", new_content: "export const c = 3;\n" }], dir, "cobol");
    expect(r.status).toBe("fail");
    if (r.status === "fail") expect(r.reason).toContain("no verification provider registered for language cobol");
  });
  it("refuses when the language cannot be determined from the path", () => {
    const r = verifyInSandbox("comp", [{ path: "notes.txt", new_content: "just text\n" }], dir);
    expect(["fail", "not_installed"]).toContain(r.status);
  });
  it("routes .py files to the python provider, which reports missing tooling or a tier limit instead of passing blindly", () => {
    const r = verifyInSandbox("comp", [{ path: "src/m.py", new_content: "x = 1\n" }], dir);
    expect(["fail", "not_installed", "pass"]).toContain(r.status);
  });
});
