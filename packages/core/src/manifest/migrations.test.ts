// src/manifest/migrations.test.ts
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listMigrations } from "./migrations";
import { closeDb } from "./store";

let originalCwd: string;
let tmpDir: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tmpDir = mkdtempSync(join(tmpdir(), "purix-migrations-test-"));
  process.chdir(tmpDir);
});

afterEach(() => {
  closeDb();
  process.chdir(originalCwd);
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("Manifest Migrations", () => {
  it("lists migrations without throwing", () => {
    const list = listMigrations();
    expect(Array.isArray(list)).toBe(true);
  });
});
