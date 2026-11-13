// src/state/reconcile_no_store.test.ts
//
// Reconciling when there is no store must create nothing. Before this, the
// pre-action step of every non-read-only command (connect, create, ...) called
// listPendingOperations(), which opens the store, which creates
// .purix/manifest.db (plus -wal and -shm) in whatever folder the command was
// run in. Seen by running `purix connect` in an empty folder.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconcilePendingOperations } from "./reconcile";
import { closeDb, getDb, storeExists } from "../manifest/store";
import { safeRmSync } from "../platform/fs_retry.js";

describe("reconcilePendingOperations with no store", () => {
  let dir: string;
  let cwd: string;
  beforeEach(() => {
    cwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), "purix-reconcile-nostore-"));
    process.chdir(dir);
  });
  afterEach(() => {
    closeDb();
    process.chdir(cwd);
    safeRmSync(dir);
  });

  it("creates no file or folder in an empty directory", async () => {
    await reconcilePendingOperations(dir);
    expect(readdirSync(dir)).toEqual([]);
    expect(storeExists()).toBe(false);
  });

  it("still opens an existing store and finds nothing pending", async () => {
    getDb(); // creates the store, as `purix index` / `create` would
    closeDb();
    expect(existsSync(join(dir, ".purix", "manifest.db"))).toBe(true);
    await reconcilePendingOperations(dir); // must not throw
    expect(storeExists()).toBe(true);
  });
});
