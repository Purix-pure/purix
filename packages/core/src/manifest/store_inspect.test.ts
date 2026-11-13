// src/manifest/store_inspect.test.ts
// D1 + corruption handling: read-only inspection never creates anything, and a
// damaged store is moved aside (never deleted).
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { storeExists, inspectStore, getDb, closeDb } from "./store";
import { safeRmSync } from "../platform/fs_retry.js";

let originalCwd: string;
let tmpDir: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tmpDir = mkdtempSync(join(tmpdir(), "purix-store-inspect-"));
  process.chdir(tmpDir);
});

afterEach(() => {
  closeDb();
  process.chdir(originalCwd);
  safeRmSync(tmpDir);
});

describe("storeExists / inspectStore", () => {
  it("reports absent and creates nothing", () => {
    expect(storeExists()).toBe(false);
    expect(inspectStore()).toEqual({ state: "absent" });
    expect(readdirSync(tmpDir)).toEqual([]);
  });

  it("reports ok for a healthy store", () => {
    getDb();
    closeDb();
    expect(storeExists()).toBe(true);
    expect(inspectStore()).toEqual({ state: "ok" });
  });

  it("reports damaged for a file that is not a database, without modifying it", () => {
    mkdirSync(join(tmpDir, ".purix"));
    const path = join(tmpDir, ".purix", "manifest.db");
    writeFileSync(path, Buffer.alloc(4096, 7));
    const before = readFileSync(path);
    const result = inspectStore();
    expect(result.state).toBe("damaged");
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(readdirSync(join(tmpDir, ".purix"))).toEqual(["manifest.db"]);
  });

  it("reports damaged for a valid header with broken pages", () => {
    const dir = join(tmpDir, ".purix");
    mkdirSync(dir);
    const path = join(dir, "manifest.db");
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode=DELETE; CREATE TABLE junk(a TEXT)");
    const ins = db.prepare("INSERT INTO junk VALUES (?)");
    for (let i = 0; i < 3000; i++) ins.run("x".repeat(200) + i);
    db.close();
    const bytes = readFileSync(path);
    for (let i = 8192; i < 8192 + 600; i++) bytes[i] = bytes[i]! ^ 0xff;
    writeFileSync(path, bytes);
    expect(inspectStore().state).toBe("damaged");
  });
});

describe("getDb on a damaged store", () => {
  it("moves the damaged file aside instead of deleting it", () => {
    const dir = join(tmpDir, ".purix");
    mkdirSync(dir);
    const path = join(dir, "manifest.db");
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode=DELETE; CREATE TABLE junk(a TEXT)");
    const ins = db.prepare("INSERT INTO junk VALUES (?)");
    for (let i = 0; i < 3000; i++) ins.run("x".repeat(200) + i);
    db.close();
    const bytes = readFileSync(path);
    for (let i = 8192; i < 8192 + 600; i++) bytes[i] = bytes[i]! ^ 0xff;
    writeFileSync(path, bytes);

    const origError = console.error;
    console.error = () => {};
    try {
      getDb();
    } finally {
      console.error = origError;
    }
    const files = readdirSync(dir);
    const aside = files.filter((f) => f.startsWith("manifest.db.corrupt-"));
    expect(aside.length).toBe(1);
    expect(readFileSync(join(dir, aside[0]!)).equals(bytes)).toBe(true);
    expect(existsSync(join(dir, "manifest.db"))).toBe(true);
    closeDb();
    expect(inspectStore()).toEqual({ state: "ok" });
  });
});
