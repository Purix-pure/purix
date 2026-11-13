// src/state/repo_lock_clock.test.ts
//
// H4 (clock moved backwards): an unreadable repository lock is "being written" while it is younger than 2 s. The age was
// `Date.now() - mtime`, so a damaged lock stamped hours in the future had a negative age and counted as "being written" for as long
// as the clock took to catch up: every acquire threw "is being written by another process". A stamp further ahead than the
// allowance (5 min, the same one `lastBeatMs` uses) is not a write in progress. Reproduced before the fix.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireRepoLock, releaseRepoLock, isRepoLockHeld } from "./repo_lock";
import { purixDir } from "../platform/layout.js";
import { safeRmSync } from "../platform/fs_retry.js";

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "purix-lock-clock-"));
  mkdirSync(purixDir(base), { recursive: true });
});
afterEach(() => {
  releaseRepoLock(base);
  safeRmSync(base);
});

describe("repo lock: a damaged lock stamped in the future", () => {
  it("is reclaimed when the stamp is far ahead of our clock", () => {
    const p = join(purixDir(base), "repo.lock");
    writeFileSync(p, "{ not json");
    const future = new Date(Date.now() + 60 * 60_000);
    utimesSync(p, future, future);
    acquireRepoLock(base);
    expect(isRepoLockHeld(base)).toBe(true);
  });
  it("is still treated as being written when the stamp is only slightly ahead", () => {
    const p = join(purixDir(base), "repo.lock");
    writeFileSync(p, "{ not json");
    const slightly = new Date(Date.now() + 500);
    utimesSync(p, slightly, slightly);
    expect(() => acquireRepoLock(base)).toThrow(/being written by another process/);
  });
});
