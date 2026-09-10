// src/manifest/store_component_limit.test.ts
//
// Part 5: writeManifestWithLimitCheck — the atomic check-and-reserve.
// Same isolation approach as store_delete.test.ts: chdir into a fresh
// temp dir per test rather than injecting a path, since DB_PATH is a
// relative ".purix/manifest.db".
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ManifestEntry } from "./schema";
import { writeManifestWithLimitCheck, listManifest, closeDb } from "./store";

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
  tmpDir = mkdtempSync(join(tmpdir(), "purix-store-limit-test-"));
  process.chdir(tmpDir);
});

afterEach(() => {
  closeDb();
  process.chdir(originalCwd);
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("writeManifestWithLimitCheck", () => {
  it("allows writes under the Free-tier default limit (25)", () => {
    for (let i = 0; i < 25; i++) {
      writeManifestWithLimitCheck(makeEntry(`comp-${i}`));
    }
    expect(listManifest().length).toBe(25);
  });

  it("throws once a 26th genuinely new component would exceed the Free-tier limit", () => {
    for (let i = 0; i < 25; i++) {
      writeManifestWithLimitCheck(makeEntry(`comp-${i}`));
    }
    expect(() => writeManifestWithLimitCheck(makeEntry("comp-25"))).toThrow(/tracks up to 25 components/);
    // And the rejected write must not have landed — the transaction rolls back whole.
    expect(listManifest().length).toBe(25);
  });

  it("re-registering (upserting) an EXISTING component never counts against the limit, even while already at the cap", () => {
    for (let i = 0; i < 25; i++) {
      writeManifestWithLimitCheck(makeEntry(`comp-${i}`));
    }
    // Updating comp-0's data is an UPSERT (same component_id), not a new
    // component — must succeed even though the project is already at 25/25.
    expect(() => writeManifestWithLimitCheck(makeEntry("comp-0", { current_version: 2 }))).not.toThrow();
    expect(listManifest().length).toBe(25);
    expect(listManifest().find((e) => e.component_id === "comp-0")?.current_version).toBe(2);
  });

  it("a rejected write leaves no partial/dangling row — the count-check and insert are atomic", () => {
    for (let i = 0; i < 25; i++) {
      writeManifestWithLimitCheck(makeEntry(`comp-${i}`));
    }
    try {
      writeManifestWithLimitCheck(makeEntry("rejected-one"));
    } catch {
      // expected
    }
    expect(listManifest().some((e) => e.component_id === "rejected-one")).toBe(false);
  });
});
