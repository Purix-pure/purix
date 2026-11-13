// src/platform/disk_full.test.ts
//
// H5: a full disk must be reported as a full disk. Before, `purix status` on a full disk said "the local store is damaged
// (disk I/O error)", which sends a person to repair a store that is fine. Reproduced on a real 1 MB filesystem on 2026-11-12.
import { describe, it } from "node:test";
import { expect } from "expect";
import { looksLikeDiskFull, isDiskFull, describeStoreProblem, DISK_FULL_SENTENCE } from "./disk_full";

const FULL = () => 0;
const ROOMY = () => 50 * 1024 * 1024;
const UNKNOWN = () => null;

describe("looksLikeDiskFull (the message alone says so)", () => {
  for (const m of [
    "ENOSPC: no space left on device, write",
    "EDQUOT: disk quota exceeded, write",
    "database or disk is full",
    "SQLITE_FULL: database or disk is full",
    "No space left on device",
  ]) {
    it(`recognises: ${m}`, () => expect(looksLikeDiskFull(m)).toBe(true));
  }
  for (const m of ["database disk image is malformed", "disk I/O error", "ENOENT: no such file or directory", "file is not a database", ""]) {
    it(`does not claim: ${m || "(empty)"}`, () => expect(looksLikeDiskFull(m)).toBe(false));
  }
});

describe("isDiskFull", () => {
  it("is true for a full-disk message whatever the free space says", () => {
    expect(isDiskFull("ENOSPC: no space left on device, write", "/x", ROOMY)).toBe(true);
  });
  it("treats a bare 'disk I/O error' as a full disk only when the filesystem has almost no free space", () => {
    expect(isDiskFull("disk I/O error", "/x", FULL)).toBe(true);
    expect(isDiskFull("disk I/O error", "/x", ROOMY)).toBe(false);
  });
  it("does not guess when the free space cannot be read", () => {
    expect(isDiskFull("disk I/O error", "/x", UNKNOWN)).toBe(false);
  });
  it("never turns a corruption message into a full disk, even on a full filesystem", () => {
    expect(isDiskFull("database disk image is malformed", "/x", FULL)).toBe(false);
    expect(isDiskFull("file is not a database", "/x", FULL)).toBe(false);
  });
});

describe("describeStoreProblem", () => {
  it("says 'damaged' for a damaged store", () => {
    expect(describeStoreProblem("database disk image is malformed", "/x", ROOMY)).toBe("the local store is damaged (database disk image is malformed).");
  });
  it("says the disk is full, and not 'damaged', when it is", () => {
    const s = describeStoreProblem("disk I/O error", "/x", FULL);
    expect(s).not.toMatch(/damaged/);
    expect(s).toMatch(/disk is full/i);
  });
  it("has one sentence for the full-disk case that names the way out", () => {
    expect(DISK_FULL_SENTENCE).toMatch(/free some space/i);
  });
});
