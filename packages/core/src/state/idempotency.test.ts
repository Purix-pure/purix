// src/state/idempotency.test.ts
//
// computeRequestKey is pure and tested directly. findPriorCommit /
// recordRequestCommit go through store.ts's getDb(), whose DB_PATH is a
// relative ".purix/manifest.db" — same isolation strategy as
// manifest/store_delete.test.ts: chdir into a fresh temp dir per test.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeRequestKey, findPriorCommit, recordRequestCommit } from "./idempotency";
import { closeDb } from "../manifest/store";

describe("computeRequestKey", () => {
  it("is deterministic for identical inputs", () => {
    const a = computeRequestKey("comp-a", "do the thing", "hash123");
    const b = computeRequestKey("comp-a", "do the thing", "hash123");
    expect(a).toBe(b);
  });

  it("normalizes whitespace in the instruction so equivalent phrasing collides", () => {
    const a = computeRequestKey("comp-a", "  do   the\tthing  ", "hash123");
    const b = computeRequestKey("comp-a", "do the thing", "hash123");
    expect(a).toBe(b);
  });

  it("normalizes case in the instruction", () => {
    const a = computeRequestKey("comp-a", "Do The Thing", "hash123");
    const b = computeRequestKey("comp-a", "do the thing", "hash123");
    expect(a).toBe(b);
  });

  it("differs when the component id differs", () => {
    const a = computeRequestKey("comp-a", "do the thing", "hash123");
    const b = computeRequestKey("comp-b", "do the thing", "hash123");
    expect(a).not.toBe(b);
  });

  it("differs when the instruction differs", () => {
    const a = computeRequestKey("comp-a", "do the thing", "hash123");
    const b = computeRequestKey("comp-a", "do another thing", "hash123");
    expect(a).not.toBe(b);
  });

  it("differs when the starting files hash differs (a real prior commit changed state)", () => {
    const a = computeRequestKey("comp-a", "do the thing", "hash123");
    const b = computeRequestKey("comp-a", "do the thing", "hash456");
    expect(a).not.toBe(b);
  });

  it("produces a 64-character lowercase hex sha256 digest", () => {
    const key = computeRequestKey("comp-a", "do the thing", "hash123");
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("findPriorCommit / recordRequestCommit (SQLite-backed)", () => {
  let originalCwd: string;
  let tmpDir: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpDir = mkdtempSync(join(tmpdir(), "purix-idempotency-test-"));
    process.chdir(tmpDir);
  });

  afterEach(() => {
    closeDb();
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null for a key that was never recorded", () => {
    expect(findPriorCommit("never-seen-key")).toBeNull();
  });

  it("returns the resulting version after a commit is recorded", () => {
    const key = computeRequestKey("comp-a", "do the thing", "hash123");
    recordRequestCommit(key, "comp-a", 2);
    expect(findPriorCommit(key)).toEqual({ resultingVersion: 2 });
  });

  it("is idempotent: recording the same key twice updates rather than duplicates", () => {
    const key = computeRequestKey("comp-a", "do the thing", "hash123");
    recordRequestCommit(key, "comp-a", 2);
    recordRequestCommit(key, "comp-a", 2);
    expect(findPriorCommit(key)).toEqual({ resultingVersion: 2 });
  });

  it("updates the stored version if the same key is recorded again with a new version", () => {
    const key = computeRequestKey("comp-a", "do the thing", "hash123");
    recordRequestCommit(key, "comp-a", 2);
    recordRequestCommit(key, "comp-a", 3);
    expect(findPriorCommit(key)).toEqual({ resultingVersion: 3 });
  });

  it("keeps distinct keys independent", () => {
    const keyA = computeRequestKey("comp-a", "do thing A", "hash123");
    const keyB = computeRequestKey("comp-a", "do thing B", "hash123");
    recordRequestCommit(keyA, "comp-a", 2);
    recordRequestCommit(keyB, "comp-a", 5);
    expect(findPriorCommit(keyA)).toEqual({ resultingVersion: 2 });
    expect(findPriorCommit(keyB)).toEqual({ resultingVersion: 5 });
  });

  it("does not throw if findPriorCommit is called before any commit was ever recorded (table not yet created)", () => {
    expect(() => findPriorCommit("anything")).not.toThrow();
  });
});