// packages/core/src/state/repo_lock.test.ts
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireRepoLock, releaseRepoLock } from "./repo_lock";
import { safeRmSync } from "../platform/fs_retry.js";

describe("Repository Advisory Lock", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "purix-lock-test-"));
  });

  afterEach(() => {
    safeRmSync(tmpDir);
  });

  it("acquires lock when free and releases successfully", () => {
    expect(() => acquireRepoLock(tmpDir)).not.toThrow();
    expect(() => releaseRepoLock(tmpDir)).not.toThrow();
  });

  it("fails fast when held by a live PID with a recent heartbeat", () => {
    acquireRepoLock(tmpDir);
    // Try to acquire again with same PID (already held, heartbeat is fresh
    // because acquireRepoLock just wrote it).
    expect(() => acquireRepoLock(tmpDir)).toThrow(/already locked by active process PID/);
    releaseRepoLock(tmpDir);
  });

  it("reclaims lock when held by a dead PID", () => {
    const purixDir = join(tmpDir, ".purix");
    mkdirSync(purixDir, { recursive: true });
    // Write lock file with a non-existent PID (e.g. 999999)
    writeFileSync(
      join(purixDir, "repo.lock"),
      JSON.stringify({ pid: 999999, timestamp: new Date().toISOString(), updatedAt: new Date().toISOString() })
    );

    expect(() => acquireRepoLock(tmpDir)).not.toThrow();
    releaseRepoLock(tmpDir);
  });

  // Regression test for a bug reproduced in practice on Windows: a lock
  // file recorded PID 10632 from a purix process that had long since
  // exited. `process.kill(pid, 0)` still reported that PID as "alive"
  // because the OS had since handed the same PID number to an unrelated
  // process (svchost.exe) — so the old PID-only check falsely treated the
  // lock as still held, and the only way out was deleting the lock file
  // by hand. A live PID with a stale (unrefreshed) heartbeat must be
  // reclaimed rather than trusted, regardless of what's currently running
  // at that PID number.
  it("reclaims lock when PID is alive but the heartbeat is stale (PID-reuse case)", () => {
    const purixDir = join(tmpDir, ".purix");
    mkdirSync(purixDir, { recursive: true });
    const longAgo = new Date(Date.now() - 60_000).toISOString(); // 60s old, well past the 30s staleness window
    writeFileSync(
      join(purixDir, "repo.lock"),
      // process.pid is guaranteed alive (it's this test process) — standing
      // in for "the OS happened to reuse this PID for something else."
      JSON.stringify({ pid: process.pid, timestamp: longAgo, updatedAt: longAgo })
    );

    expect(() => acquireRepoLock(tmpDir)).not.toThrow();
    releaseRepoLock(tmpDir);
  });

  it("does NOT reclaim a live PID with a heartbeat inside the staleness window", () => {
    const purixDir = join(tmpDir, ".purix");
    mkdirSync(purixDir, { recursive: true });
    const justNow = new Date().toISOString();
    writeFileSync(
      join(purixDir, "repo.lock"),
      JSON.stringify({ pid: process.pid, timestamp: justNow, updatedAt: justNow })
    );

    expect(() => acquireRepoLock(tmpDir)).toThrow(/already locked by active process PID/);
    // No release here — this lock wasn't acquired by us in this test (the
    // acquire attempt above threw), so releaseRepoLock would no-op anyway
    // since releaseRepoLock only removes a lock whose pid === process.pid.
    // Clean up directly instead of pretending we hold it.
    safeRmSync(join(purixDir, "repo.lock"), { force: true });
  });
});