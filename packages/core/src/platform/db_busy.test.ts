// H5: a locked store is not a damaged store. The classifier names a lock; it never names corruption.
import { describe, it } from "node:test";
import { expect } from "expect";
import { isDatabaseBusy, DATABASE_BUSY_SENTENCE } from "./db_busy.js";
import { describeStoreProblem } from "./disk_full.js";

describe("database busy classifier", () => {
  it("recognises SQLite's lock messages", () => {
    for (const m of ["database is locked", "SQLITE_BUSY: database is locked", "Error: database table is locked", "llm_call_log: still busy after 5 attempts"]) {
      expect(isDatabaseBusy(m)).toBe(true);
    }
  });
  it("does not call corruption, a full disk or an unrelated error a lock", () => {
    for (const m of ["database disk image is malformed", "file is not a database", "ENOSPC: no space left on device", "disk I/O error", "No Purix state here yet.", ""]) {
      expect(isDatabaseBusy(m)).toBe(false);
    }
  });
  it("the sentence tells the person to wait and re-run, and claims nothing about damage", () => {
    expect(DATABASE_BUSY_SENTENCE).toMatch(/another Purix process/i);
    expect(DATABASE_BUSY_SENTENCE).toMatch(/run the command again/i);
    expect(DATABASE_BUSY_SENTENCE).not.toMatch(/damag|corrupt/i);
  });
  it("a read-only command reports a lock as busy, not as 'damaged'", () => {
    expect(describeStoreProblem("database is locked", "/p")).not.toMatch(/damaged/);
    expect(describeStoreProblem("database is locked", "/p")).toMatch(/busy|another Purix process/i);
  });
});
