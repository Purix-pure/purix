// The dashboard, `watch` and the result line read the record while Purix may be writing to it. The store is in WAL mode, where a
// reader sees the last committed state and neither waits for nor blocks a writer. These tests check that, and that reading changes nothing.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getDb, storeDirectory, getDbFilePath } from "../manifest/store.js";
import { recordEvent } from "../manifest/events.js";
import { openLedger } from "./ledger_reader.js";
import { safeRmSync } from "../platform/fs_retry.js";

let cwd: string, dir: string;
beforeEach(() => { cwd = process.cwd(); dir = mkdtempSync(join(tmpdir(), "purix-wal-")); process.chdir(dir); getDb(); });
afterEach(() => { closeDb(); process.chdir(cwd); safeRmSync(dir); });

describe("reading the record while Purix writes", () => {
  it("the store is in WAL mode", () => {
    const row = getDb().prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(row.journal_mode.toLowerCase()).toBe("wal");
  });

  it("a reader answers while a writer holds an open transaction, and sees only what was committed", () => {
    recordEvent("request", { component_id: "a", operation: "modify" });
    const db = getDb();
    db.exec("BEGIN IMMEDIATE");
    try {
      recordEvent("request", { component_id: "b", operation: "modify" }); // inside the open transaction: not committed yet
      const started = Date.now();
      const ledger = openLedger(storeDirectory());
      expect(ledger).not.toBeNull();
      try {
        expect(ledger!.eventsAfter(0).map((e) => e.componentId)).toEqual(["a"]);
        ledger!.summary(); // the whole summary also reads without waiting for the writer
      } finally { ledger!.close(); }
      expect(Date.now() - started).toBeLessThan(1000);
    } finally {
      db.exec("COMMIT");
    }
    const after = openLedger(storeDirectory());
    try { expect(after!.eventsAfter(0).map((e) => e.componentId)).toEqual(["a", "b"]); } finally { after!.close(); }
  });

  it("reading writes nothing: the database file is byte-for-byte the same afterwards", () => {
    recordEvent("request", { component_id: "a", operation: "modify" });
    closeDb(); // fold the write-ahead log into the file, so the main file is what a reader sees
    const file = getDbFilePath() ?? join(storeDirectory(), "manifest.db");
    expect(existsSync(file)).toBe(true);
    const before = readFileSync(file);
    const ledger = openLedger(storeDirectory());
    try { ledger!.summary(); ledger!.changes(); ledger!.stops(); ledger!.components(); } finally { ledger!.close(); }
    expect(readFileSync(file).equals(before)).toBe(true);
  });
});
