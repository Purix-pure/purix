// src/verify/verify.test.ts
//
// These tests actually invoke real tsc (symlinking this project's own
// node_modules into a fresh temp dir so verifyComponent finds the local,
// version-pinned binary — same trick sandbox.ts uses for its real runs —
// rather than falling through to an un-pinned `bunx tsc`). Slower than a
// pure unit test, but the whole point of this file is proving the actual
// compiler flags behave as claimed; mocking tsc would test nothing real.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyComponent } from "./verify";
import { resolveRealNodeModules } from "../test-support/real_node_modules";

const REAL_NODE_MODULES = resolveRealNodeModules();

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "purix-verify-test-"));
  if (REAL_NODE_MODULES) {
    try {
      symlinkSync(REAL_NODE_MODULES, join(tmpDir, "node_modules"), "junction");
    } catch {
      // best-effort, same as sandbox.ts — falls through to bunx if this fails
    }
  }
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("verifyComponent — no files", () => {
  it("fails immediately without invoking tsc at all when given an empty file list", () => {
    const result = verifyComponent([], tmpDir);
    expect(result.status).toBe("fail");
    if (result.status === "fail") expect(result.reason).toMatch(/No files to verify/);
  });
});

describe("verifyComponent — fallback path (no tsconfig.json in baseDir)", () => {
  it("passes on genuinely valid, strict-clean TypeScript", () => {
    const filePath = join(tmpDir, "ok.ts");
    writeFileSync(filePath, `export function add(a: number, b: number): number {\n  return a + b;\n}\n`);
    const result = verifyComponent([filePath], tmpDir);
    expect(result.status).toBe("pass");
  });

  it("fails on a straightforward strict-mode violation (implicit any)", () => {
    const filePath = join(tmpDir, "bad.ts");
    writeFileSync(filePath, `export function add(a, b) {\n  return a + b;\n}\n`);
    const result = verifyComponent([filePath], tmpDir);
    expect(result.status).toBe("fail");
    if (result.status === "fail") expect(result.reason.toLowerCase()).toContain("implicit");
  });

  it("enforces noUncheckedIndexedAccess — one of the flags the prior fallback flag set was missing entirely", () => {
    // Without noUncheckedIndexedAccess, `arr[0]` types as `string`, and
    // .toUpperCase() is fine. With it (this project's real setting),
    // `arr[0]` types as `string | undefined`, and this is a compile error.
    // This is the regression check for the fallback-flag fix: before it,
    // this file would have wrongly passed.
    const filePath = join(tmpDir, "unchecked_index.ts");
    writeFileSync(
      filePath,
      `export function firstUpper(arr: string[]): string {\n  return arr[0].toUpperCase();\n}\n`
    );
    const result = verifyComponent([filePath], tmpDir);
    expect(result.status).toBe("fail");
    if (result.status === "fail") expect(result.reason).toMatch(/possibly 'undefined'/);
  });

  it("accepts the same noUncheckedIndexedAccess case once it's actually guarded", () => {
    const filePath = join(tmpDir, "checked_index.ts");
    writeFileSync(
      filePath,
      `export function firstUpper(arr: string[]): string {\n  const first = arr[0];\n  if (first === undefined) throw new Error("empty");\n  return first.toUpperCase();\n}\n`
    );
    const result = verifyComponent([filePath], tmpDir);
    expect(result.status).toBe("pass");
  });

  it("enforces noFallthroughCasesInSwitch — also missing from the prior fallback flag set", () => {
    const filePath = join(tmpDir, "fallthrough.ts");
    writeFileSync(
      filePath,
      `export function label(n: number): string {\n  let out = "";\n  switch (n) {\n    case 1:\n      out = "one";\n    case 2:\n      out = "two";\n      break;\n    default:\n      out = "other";\n  }\n  return out;\n}\n`
    );
    const result = verifyComponent([filePath], tmpDir);
    expect(result.status).toBe("fail");
    if (result.status === "fail") expect(result.reason.toLowerCase()).toContain("fallthrough");
  });
});

describe("verifyComponent — tsconfig.json path (defers entirely to `tsc -p`)", () => {
  it("passes valid code when a real tsconfig.json is present in baseDir", () => {
    writeFileSync(
      join(tmpDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ESNext",
          module: "Preserve",
          moduleResolution: "bundler",
          strict: true,
          skipLibCheck: true,
          noEmit: true,
        },
      })
    );
    const filePath = join(tmpDir, "ok.ts");
    writeFileSync(filePath, `export const x: number = 1;\n`);
    const result = verifyComponent([filePath], tmpDir);
    expect(result.status).toBe("pass");
  });

  it("respects a stricter project-level setting (noUnusedLocals) that isn't part of the fallback flag set at all", () => {
    writeFileSync(
      join(tmpDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ESNext",
          module: "Preserve",
          moduleResolution: "bundler",
          strict: true,
          skipLibCheck: true,
          noEmit: true,
          noUnusedLocals: true,
        },
      })
    );
    const filePath = join(tmpDir, "unused.ts");
    writeFileSync(filePath, `export function fn(): number {\n  const unused = 5;\n  return 1;\n}\n`);
    const result = verifyComponent([filePath], tmpDir);
    expect(result.status).toBe("fail");
    if (result.status === "fail") expect(result.reason.toLowerCase()).toContain("unused");
  });
});