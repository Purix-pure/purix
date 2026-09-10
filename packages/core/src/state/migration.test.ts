// src/state/migration.test.ts
//
// Real (temporary) SQLite via bun:sqlite for the migrations table, real
// tsc, real `bun test` inside sandbox.ts's real temp-dir sandbox — same
// "isolation via chdir into a fresh temp dir, not via mocking" discipline
// store_delete.test.ts and verify.test.ts already establish. The whole
// point of these tests is proving activateMigration genuinely runs a
// full sandbox pass (compile + this component's own tests) BEFORE it
// writes anything real; mocking verifyInSandbox would test nothing real
// about the gap this file exists to close.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageMigration, activateMigration } from "./migration";
import { getMigration } from "../manifest/migrations";
import { closeDb } from "../manifest/store";
import { resolveRealNodeModules } from "../test-support/real_node_modules";

const REAL_NODE_MODULES = resolveRealNodeModules();

const BEFORE_CONTENT = `export function add(a: number, b: number): number {\n  return a + b;\n}\n`;
const TEST_CONTENT = `import { describe, it } from "node:test";\nimport { expect } from "expect";\nimport { add } from "./component";\n\ndescribe("add", () => {\n  it("adds two numbers", () => {\n    expect(add(2, 3)).toBe(5);\n  });\n});\n`;
// Compiles cleanly — same signature, same types — but flips the
// operation, so it breaks the existing test above without ever
// tripping a compile error. This is exactly the class of change a
// compile-only check (what activateMigration used to run, post-write)
// would have let straight through.
const AFTER_CONTENT_BREAKS_TEST = `export function add(a: number, b: number): number {\n  return a - b;\n}\n`;
// Compiles AND keeps the existing test passing.
const AFTER_CONTENT_CLEAN = `export function add(a: number, b: number): number {\n  // sum the two inputs\n  return a + b;\n}\n`;

let originalCwd: string;
let tmpDir: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tmpDir = mkdtempSync(join(tmpdir(), "purix-migration-test-"));
  writeFileSync(join(tmpDir, "component.ts"), BEFORE_CONTENT);
  writeFileSync(join(tmpDir, "component.test.ts"), TEST_CONTENT);
  if (REAL_NODE_MODULES) {
    try {
      symlinkSync(REAL_NODE_MODULES, join(tmpDir, "node_modules"), "junction");
    } catch {
      // best-effort, same fallback sandbox.ts itself tolerates
    }
  }
  process.chdir(tmpDir);
});

afterEach(() => {
  closeDb();
  process.chdir(originalCwd);
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("activateMigration — pre-write sandbox pass", () => {
  it("refuses to write, and leaves the migration staged, when the after-snapshot compiles but fails this component's own test suite", { timeout: 30000 }, async () => {
    const id = stageMigration(
      "comp-a",
      "update_prompt_text",
      1,
      2,
      [{ path: "component.ts", content: BEFORE_CONTENT }],
      [{ path: "component.ts", content: AFTER_CONTENT_BREAKS_TEST }]
    );

    const result = await activateMigration(id, tmpDir);

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/sandbox/i);

    // Nothing was written — real on-disk content is untouched.
    expect(readFileSync(join(tmpDir, "component.ts"), "utf-8")).toBe(BEFORE_CONTENT);

    // The migration itself is still staged, not silently advanced.
    expect(getMigration(id)?.status).toBe("staged");
  });

  it("writes the after-snapshot and marks the migration active when the sandbox pass is clean", { timeout: 30000 }, async () => {
    const id = stageMigration(
      "comp-a",
      "update_prompt_text",
      1,
      2,
      [{ path: "component.ts", content: BEFORE_CONTENT }],
      [{ path: "component.ts", content: AFTER_CONTENT_CLEAN }]
    );

    const result = await activateMigration(id, tmpDir);

    expect(result.ok).toBe(true);
    expect(readFileSync(join(tmpDir, "component.ts"), "utf-8")).toBe(AFTER_CONTENT_CLEAN);
    expect(getMigration(id)?.status).toBe("active");
  });
});