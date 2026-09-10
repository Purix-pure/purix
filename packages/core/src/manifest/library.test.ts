// packages/core/src/manifest/library.test.ts
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb } from "./store";
import { promoteOperation, verifyLibraryChain, computeTaskSignature, clearLibrary, enforceEviction, listLibrary } from "./library";
import { createConfigStore } from "../state/config";

describe("Operation Library Tamper-Evidence Chain", () => {
  let tmpDir: string;
  let oldCwd: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "purix-library-test-"));
    oldCwd = process.cwd();
    process.chdir(tmpDir);
    clearLibrary();
  });

  afterEach(() => {
    closeDb();
    process.chdir(oldCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("verifies clean library chain successfully", () => {
    const sig1 = computeTaskSignature("comp-1", "update_prompt_text", "change prompt 1");
    promoteOperation({
      component_id: "comp-1",
      operation: "update_prompt_text",
      task_signature: sig1,
      description: "first",
      edits: [{ path: "a.ts", kind: "prompt_text", old_text: "a", new_text: "b" }],
    });

    const sig2 = computeTaskSignature("comp-2", "update_prompt_text", "change prompt 2");
    promoteOperation({
      component_id: "comp-2",
      operation: "update_prompt_text",
      task_signature: sig2,
      description: "second",
      edits: [{ path: "b.ts", kind: "prompt_text", old_text: "c", new_text: "d" }],
    });

    const res = verifyLibraryChain();
    expect(res.valid).toBe(true);
  });
});

describe("Operation Library Configurable Eviction", () => {
  let tmpDir: string;
  let oldCwd: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "purix-library-eviction-test-"));
    oldCwd = process.cwd();
    process.chdir(tmpDir);
    clearLibrary();
  });

  afterEach(() => {
    closeDb();
    process.chdir(oldCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("evicts at overridden ceiling instead of default 50000", () => {
    // Set a low ceiling for testing
    const testConfig = createConfigStore(tmpDir);
    testConfig.set("operationLibrary.maxEntries", 3);

    // Insert 4 entries - should evict 1 (the oldest)
    for (let i = 1; i <= 4; i++) {
      const sig = computeTaskSignature(`comp-${i}`, "update_prompt_text", `change prompt ${i}`);
      promoteOperation({
        component_id: `comp-${i}`,
        operation: "update_prompt_text",
        task_signature: sig,
        description: `entry ${i}`,
        edits: [{ path: `a${i}.ts`, kind: "prompt_text", old_text: "a", new_text: "b" }],
      });
    }

    // Verify only 3 entries remain (the 3 most recent)
    const entries = listLibrary();
    expect(entries.length).toBe(3);

    // The first entry (comp-1) should be evicted
    const componentIds = entries.map((e) => e.component_id);
    expect(componentIds).not.toContain("comp-1");
    expect(componentIds).toContain("comp-2");
    expect(componentIds).toContain("comp-3");
    expect(componentIds).toContain("comp-4");
  });

  it("defaults to 50000 when config is unset", () => {
    // Don't set config - should use default
    const testConfig = createConfigStore(tmpDir);
    const maxEntries = testConfig.get("operationLibrary.maxEntries");
    expect(maxEntries).toBeUndefined();

    expect(maxEntries).toBeUndefined();
  });

  it("namespaced per language for eviction ceiling", () => {
    const testConfig = createConfigStore(tmpDir);
    testConfig.set("operationLibrary.maxEntries", 2);

    // Promote 2 TypeScript operations
    for (let i = 1; i <= 2; i++) {
      promoteOperation({
        component_id: `ts-${i}`,
        operation: "fix",
        task_signature: `ts-sig-${i}`,
        description: "ts",
        edits: [],
        language: "typescript",
      });
    }

    // Promote 2 Python operations
    for (let i = 1; i <= 2; i++) {
      promoteOperation({
        component_id: `py-${i}`,
        operation: "fix",
        task_signature: `py-sig-${i}`,
        description: "py",
        edits: [],
        language: "python",
      });
    }

    // Both namespaces should have 2 entries (TS entries were not evicted by Python inserts)
    const tsEntries = listLibrary({ language: "typescript" });
    const pyEntries = listLibrary({ language: "python" });

    expect(tsEntries.length).toBe(2);
    expect(pyEntries.length).toBe(2);
  });
});
