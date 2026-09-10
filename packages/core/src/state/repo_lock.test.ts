// packages/core/src/state/repo_lock.test.ts
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireRepoLock, releaseRepoLock } from "./repo_lock";

describe("Repository Advisory Lock", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "purix-lock-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("acquires lock when free and releases successfully", () => {
    expect(() => acquireRepoLock(tmpDir)).not.toThrow();
    expect(() => releaseRepoLock(tmpDir)).not.toThrow();
  });

  it("fails fast when held by a live PID", () => {
    acquireRepoLock(tmpDir);
    // Try to acquire again with same PID (already held)
    expect(() => acquireRepoLock(tmpDir)).toThrow(/already locked by active process PID/);
    releaseRepoLock(tmpDir);
  });

  it("reclaims lock when held by a dead PID", () => {
    const purixDir = join(tmpDir, ".purix");
    mkdirSync(purixDir, { recursive: true });
    // Write lock file with a non-existent PID (e.g. 999999)
    writeFileSync(
      join(purixDir, "repo.lock"),
      JSON.stringify({ pid: 999999, timestamp: new Date().toISOString() })
    );

    expect(() => acquireRepoLock(tmpDir)).not.toThrow();
    releaseRepoLock(tmpDir);
  });
});
