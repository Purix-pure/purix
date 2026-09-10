// src/manifest/store.test.ts
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ManifestEntry } from "./schema";
import { writeManifestWithLimitCheck, readManifest, closeDb } from "./store";

function makeEntry(id: string, opts: Partial<ManifestEntry> = {}): ManifestEntry {
  return {
    component_id: id,
    component_type: "module",
    current_version: 1,
    schema_version: 2,
    parts: { tools: [], config: {} },
    files: [`${id}.ts`],
    depends_on: [],
    depended_on_by: [],
    version_history: [],
    verification_status: "pending",
    last_synced_hash: null,
    ...opts,
  };
}

let originalCwd: string;
let tmpDir: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tmpDir = mkdtempSync(join(tmpdir(), "purix-store-dir-test-"));
  process.chdir(tmpDir);
});

afterEach(() => {
  closeDb();
  process.chdir(originalCwd);
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("Manifest Store Direct Tests", () => {
  it("writes and reads back manifest entries successfully", () => {
    const entry = makeEntry("comp-1");
    writeManifestWithLimitCheck(entry);
    const item = readManifest("comp-1");
    expect(item).toBeTruthy();
    expect(item?.component_id).toBe("comp-1");
  });
});
