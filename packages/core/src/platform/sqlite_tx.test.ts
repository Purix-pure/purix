// A1: withImmediateTx.
import { describe, it } from "node:test";
import { expect } from "expect";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withImmediateTx } from "./sqlite_tx.js";

const mem = () => { const db = new DatabaseSync(":memory:"); db.exec("CREATE TABLE t (v INTEGER)"); return db; };
const count = (db: DatabaseSync) => (db.prepare("SELECT COUNT(*) AS n FROM t").get() as { n: number }).n;

describe("withImmediateTx", () => {
  it("commits and returns the callback's value", () => {
    const db = mem();
    expect(withImmediateTx(db, () => { db.exec("INSERT INTO t VALUES (1)"); return 42; })).toBe(42);
    expect(count(db)).toBe(1);
  });
  it("rolls back and rethrows the original error", () => {
    const db = mem();
    expect(() => withImmediateTx(db, () => { db.exec("INSERT INTO t VALUES (1)"); throw new Error("nope"); })).toThrow("nope");
    expect(count(db)).toBe(0);
  });
  it("an inner failure caught by the outer call rolls back only the inner work", () => {
    const db = mem();
    withImmediateTx(db, () => {
      db.exec("INSERT INTO t VALUES (1)");
      try { withImmediateTx(db, () => { db.exec("INSERT INTO t VALUES (2)"); throw new Error("inner"); }); } catch { /* expected */ }
    });
    expect(count(db)).toBe(1);
  });
  it("an outer failure rolls back an inner success", () => {
    const db = mem();
    expect(() => withImmediateTx(db, () => { withImmediateTx(db, () => db.exec("INSERT INTO t VALUES (1)")); throw new Error("outer"); })).toThrow("outer");
    expect(count(db)).toBe(0);
  });
  it("rejects an async callback and rolls back", () => {
    const db = mem();
    expect(() => withImmediateTx(db, (() => { db.exec("INSERT INTO t VALUES (1)"); return Promise.resolve(1); }))).toThrow(/returned a promise/);
    expect(count(db)).toBe(0);
  });
  it("works again after a failure (depth bookkeeping resets)", () => {
    const db = mem();
    try { withImmediateTx(db, () => { throw new Error("x"); }); } catch { /* expected */ }
    withImmediateTx(db, () => db.exec("INSERT INTO t VALUES (7)"));
    expect(count(db)).toBe(1);
  });
  it("takes the write lock at the start: a second connection cannot begin while the first is inside", () => {
    const path = join(mkdtempSync(join(tmpdir(), "purix-tx-")), "a.db");
    const a = new DatabaseSync(path); const b = new DatabaseSync(path);
    a.exec("CREATE TABLE t (v INTEGER)"); b.exec("PRAGMA busy_timeout = 0");
    let blocked = "";
    withImmediateTx(a, () => {
      try { withImmediateTx(b, () => undefined); } catch (e) { blocked = String((e as Error).message); }
    });
    expect(blocked).toMatch(/locked|busy/i);
    withImmediateTx(b, () => undefined); // free again
    a.close(); b.close();
  });
});
