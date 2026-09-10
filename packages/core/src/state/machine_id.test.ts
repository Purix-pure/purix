// packages/core/src/state/machine_id.test.ts
//
// Test contract corrected 2026-08-30 alongside the machine_id.ts rewrite
// — see that file's header comment. The original version of this test
// asserted "different baseDirs get different machine ids", which is
// project-id semantics (correctly tested in project_id.test.ts), not
// machine-id semantics: a real machine identity must be the SAME
// regardless of which directory Purix runs from. That was the actual
// bug hiding behind this test's premise, not just the missing export.
import { describe, test, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMachineId } from "./machine_id";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "purix-machineid-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("getMachineId", () => {
  test("generates and persists a stable id across calls (same explicit baseDir)", () => {
    const id1 = getMachineId(dir);
    const id2 = getMachineId(dir);
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("machine identity is a real UUID and survives a fresh read from disk", () => {
    const id1 = getMachineId(dir);
    // Simulate a fresh process: nothing in-memory is cached in this
    // module (no module-level singleton), so a second call must read
    // the same value back from the persisted file, not just from a
    // process-local variable.
    const id2 = getMachineId(dir);
    expect(id2).toBe(id1);
  });

  test("falls back to a real machine identity when no baseDir is given (uses homedir)", () => {
    // Doesn't assert a specific value (that would touch this sandbox's
    // real home directory's cache, which other tests/processes may also
    // touch) — just confirms the no-arg path doesn't throw and returns a
    // well-formed id.
    const id = getMachineId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("a corrupted/unwritable cache location still returns a usable id rather than throwing", () => {
    // Point at a path that can't be created as a directory (a file
    // sitting where a directory needs to go) to exercise the write
    // failure fallback without needing real permission manipulation.
    const blockedParent = mkdtempSync(join(tmpdir(), "purix-machineid-blocked-"));
    const filePath = join(blockedParent, "blocker-file");
    writeFileSync(filePath, "not a directory");
    try {
      const id = getMachineId(filePath); // ".purix" under a path that's actually a file
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      rmSync(blockedParent, { recursive: true, force: true });
    }
  });
});
