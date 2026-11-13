// src/state/config_lock_clock.test.ts
//
// H4 (clock moved backwards): the config lock is a directory whose age is `Date.now() - mtime`. If the clock was set back after
// the lock was taken (or the lock was written by a machine whose clock is ahead, on a shared folder), the lock's modification time
// lies in the future and the age is negative, so a lock with no recorded holder never counts as old and every writer times out.
// `repo_lock.ts` already ignores a beat that far in the future (A2b); the config lock did not. Reproduced before the fix.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, mkdirSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfigStoreInDir } from "./config";
import { safeRmSync } from "../platform/fs_retry.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "purix-cfg-clock-"));
});
afterEach(() => safeRmSync(dir));

describe("config lock: a lock stamped in the future (clock stepped back)", () => {
  it("with no recorded holder, is treated as abandoned once its stamp is more than the skew allowance ahead", () => {
    const lock = join(dir, "config.lock");
    mkdirSync(lock);
    const future = new Date(Date.now() + 60 * 60_000);
    utimesSync(lock, future, future);
    const store = createConfigStoreInDir(dir);
    store.set("k", "v");
    expect(store.get("k")).toBe("v");
    expect(existsSync(lock)).toBe(false);
  });
  it("a freshly made lock with no holder yet is still left alone (a small lead is ordinary clock noise)", () => {
    const lock = join(dir, "config.lock");
    mkdirSync(lock);
    const slightlyAhead = new Date(Date.now() + 1_000);
    utimesSync(lock, slightlyAhead, slightlyAhead);
    const store = createConfigStoreInDir(dir);
    expect(() => store.set("k", "v")).toThrow(/Timed out waiting for the config lock/);
  });
});
