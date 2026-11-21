// packages/core/src/manifest/indexer.test.ts
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIndex } from "./indexer";
import { readManifest, closeDb } from "./store";
import { migrateManifestEntry } from "./schema_migrations";
import { safeRmSync } from "../platform/fs_retry.js";

let originalCwd: string;
let tmpDir: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tmpDir = mkdtempSync(join(tmpdir(), "purix-indexer-test-"));
  process.chdir(tmpDir);
  writeFileSync(
    join(tmpDir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { target: "es2022", module: "esnext", moduleResolution: "node", noEmit: true } })
  );
  writeFileSync(
    join(tmpDir, "sample.ts"),
    `export function helloWorld(): string {\n  return "Hello World";\n}\n`
  );
});

afterEach(() => {
  closeDb();
  process.chdir(originalCwd);
  safeRmSync(tmpDir);
});

describe("Purix Indexer & Components Sync", () => {
  it("indexes codebase, writes manifest, and syncs components.json (nothing is compiled or tested here)", async () => {
    const result = await runIndex(tmpDir);
    expect(result.fileCount).toBeGreaterThan(0);
    expect(result.componentCount).toBeGreaterThan(0);
    expect(result.components.some((c) => c.symbol_name === "helloWorld")).toBe(true);

    // Confirm components.json is regenerated and matches DB state
    const componentsJsonPath = join(tmpDir, ".purix", "components.json");
    expect(existsSync(componentsJsonPath)).toBe(true);
    const parsedComponents = JSON.parse(readFileSync(componentsJsonPath, "utf-8"));
    expect(parsedComponents).toEqual(result.components);

    // Confirm manifest entry lands on the current schema version and fields
    const entry = readManifest("purix-codebase-index");
    expect(entry).not.toBeNull();
    expect(entry?.schema_version).toBe(5);
    expect(entry?.components).toBeDefined();
    expect(entry?.components?.length).toBe(result.components.length);
  });

  it("records the index row as pending on every run: indexing runs no verification, so it never claims pass or fail", async () => {
    await runIndex(tmpDir);
    expect(readManifest("purix-codebase-index")?.verification_status).toBe("pending");
    await runIndex(tmpDir);
    expect(readManifest("purix-codebase-index")?.verification_status).toBe("pending");
  });

  it("handles manifest schema migration from version 3 to current correctly", () => {
    const v3Entry = {
      component_id: "test-v3",
      component_type: "codebase_index",
      current_version: 1,
      schema_version: 3,
      parts: { tools: [], config: {} },
      files: ["sample.ts"],
      depends_on: [],
      depended_on_by: [],
      version_history: [],
      verification_status: "pass",
      last_synced_hash: null,
      language: "typescript",
    };

    const { entry, migrated } = migrateManifestEntry(v3Entry as any);
    expect(migrated).toBe(true);
    expect(entry.schema_version).toBe(5);
    expect(entry.components).toEqual([]);
  });
});

describe("What the index records (problem register 2026-11-20)", () => {
  it("lists the left-out files by name, and the count is the length of that list (IDX-07)", async () => {
    writeFileSync(join(tmpDir, "data.json"), "{}");
    writeFileSync(join(tmpDir, "notes.md"), "x");
    writeFileSync(join(tmpDir, "run.go"), "package main\n");
    const result = await runIndex(tmpDir);
    expect(result.unsupportedFiles).toEqual(expect.arrayContaining(["data.json", "notes.md", "run.go"]));
    expect(result.unsupportedFileCount).toBe(result.unsupportedFiles.length);
    expect(result.unsupportedFiles).toEqual([...result.unsupportedFiles].sort());
  });

  it("records no symbol for export text inside a string or comment, and no test-file symbol as reusable (IDX-01, IDX-04)", async () => {
    writeFileSync(join(tmpDir, "x.test.ts"), 'const SRC = "export const a = 1;\\n";\n// export function inComment() {}\nexport function helper() {}\n');
    const result = await runIndex(tmpDir);
    const inTest = result.components.filter((c) => c.file_location === "x.test.ts");
    expect(inTest.map((c) => c.symbol_name)).toEqual(["helper"]);
    expect(inTest.every((c) => c.reusable === false)).toBe(true);
    expect(result.components.find((c) => c.symbol_name === "helloWorld")?.reusable).toBe(true);
  });

  it("gives every (name, file) pair one entry (IDX-06) and a whole-file entry only to a file with nothing to record", async () => {
    writeFileSync(join(tmpDir, "y.test.ts"), 'const A = "export const a = 1;";\nconst B = "export const a = 2;";\n');
    const result = await runIndex(tmpDir);
    const keys = result.components.map((c) => `${c.symbol_name}@${c.file_location}`);
    expect(new Set(keys).size).toBe(keys.length);
    const whole = result.components.filter((c) => c.file_location === "y.test.ts");
    expect(whole).toHaveLength(1);
    expect(whole[0]!.signature).toBe("file:y.test.ts");
    expect(whole[0]!.reusable).toBe(false);
  });

  it("stores the parameters and return type in the signature (IDX-03)", async () => {
    const result = await runIndex(tmpDir);
    expect(result.components.find((c) => c.symbol_name === "helloWorld")?.signature).toBe("export function helloWorld(): string");
  });
});
