// src/platform/sqlite_compat.test.ts
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { DatabaseSync } from "node:sqlite";
import { CompatDb } from "./sqlite_compat";

describe("SQLite Compat", () => {
  let db: DatabaseSync;
  let compat: CompatDb;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE test (id TEXT)");
    compat = new CompatDb(db);
  });

  afterEach(() => {
    db.close();
  });

  it("supports query and run shape", () => {
    compat.run("INSERT INTO test (id) VALUES (?)", ["1"]);
    const row = compat.query("SELECT * FROM test WHERE id = ?").get("1") as any;
    expect(row.id).toBe("1");
    const all = compat.query("SELECT * FROM test").all();
    expect(all.length).toBe(1);
  });
});
