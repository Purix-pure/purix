// packages/core/src/manifest/indexer.test.ts
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIndex } from "./indexer";
import { readManifest, closeDb } from "./store";
import { migrateManifestEntry } from "./schema_migrations";

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
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("Purix Indexer & Components Sync", () => {
  it("indexes codebase, verifies in sandbox, writes manifest, and syncs components.json", async () => {
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
