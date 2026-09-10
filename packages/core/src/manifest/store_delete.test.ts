// src/manifest/store_delete.test.ts
//
// Runs against a real (temporary) SQLite file via bun:sqlite, not a mock —
// store.ts's DB_PATH is a relative ".purix/manifest.db", so isolation here
// comes from chdir-ing into a fresh temp directory before each test and
// back out afterward, rather than from injecting a path.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ManifestEntry } from "./schema";
import {
  writeManifest,
  readManifest,
  deleteManifestEntry,
  removeDependent,
  removeDependencyReference,
  addDependent,
  closeDb,
} from "./store";

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
  tmpDir = mkdtempSync(join(tmpdir(), "purix-store-test-"));
  process.chdir(tmpDir);
});

afterEach(() => {
    closeDb(); // Ensure the SQLite file is closed before deleting the temp dir
  process.chdir(originalCwd);
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("deleteManifestEntry", () => {
  it("removes a component so readManifest no longer finds it", () => {
    writeManifest(makeEntry("comp-a"));
    expect(readManifest("comp-a")).not.toBeNull();

    deleteManifestEntry("comp-a");
    expect(readManifest("comp-a")).toBeNull();
  });

  it("is a no-op (does not throw) when deleting a component that was never written", () => {
    expect(() => deleteManifestEntry("never-existed")).not.toThrow();
  });

  it("only removes the targeted component, leaving others intact", () => {
    writeManifest(makeEntry("comp-a"));
    writeManifest(makeEntry("comp-b"));

    deleteManifestEntry("comp-a");

    expect(readManifest("comp-a")).toBeNull();
    expect(readManifest("comp-b")).not.toBeNull();
  });
});

describe("removeDependencyReference (forced-delete cleanup, dependent -> deleted)", () => {
  it("strips the removed id out of a dependent's depends_on list", () => {
    writeManifest(makeEntry("base"));
    writeManifest(makeEntry("dependent", { depends_on: ["base"] }));

    removeDependencyReference("dependent", "base");

    const dependent = readManifest("dependent");
    expect(dependent?.depends_on).toEqual([]);
  });

  it("leaves other entries in depends_on untouched", () => {
    writeManifest(makeEntry("base"));
    writeManifest(makeEntry("other"));
    writeManifest(makeEntry("dependent", { depends_on: ["base", "other"] }));

    removeDependencyReference("dependent", "base");

    expect(readManifest("dependent")?.depends_on).toEqual(["other"]);
  });

  it("is a no-op if the dependent entry doesn't exist", () => {
    expect(() => removeDependencyReference("missing", "base")).not.toThrow();
  });
});

describe("removeDependent (forward cleanup, target -> dependent)", () => {
  it("strips the dependent id out of the target's depended_on_by list", () => {
    writeManifest(makeEntry("base", { depended_on_by: ["dependent"] }));

    removeDependent("base", "dependent");

    expect(readManifest("base")?.depended_on_by).toEqual([]);
  });
});

describe("delete-command dependency graph cleanup (both directions together)", () => {
  it("fully detaches a deleted component from both its dependencies and its dependents", () => {
    // base <- middle <- top   (middle depends_on base; top depends_on middle)
    writeManifest(makeEntry("base"));
    writeManifest(makeEntry("middle", { depends_on: ["base"] }));
    addDependent("base", "middle");
    writeManifest(makeEntry("top", { depends_on: ["middle"] }));
    addDependent("middle", "top");

    // Simulate what the `delete middle --force` command does: clean up
    // both directions before the row itself disappears.
    const middle = readManifest("middle")!;
    for (const depId of middle.depends_on) removeDependent(depId, "middle");
    for (const dependentId of middle.depended_on_by) removeDependencyReference(dependentId, "middle");
    deleteManifestEntry("middle");

    expect(readManifest("middle")).toBeNull();
    // base no longer lists middle as a dependent
    expect(readManifest("base")?.depended_on_by).toEqual([]);
    // top no longer lists middle as a dependency
    expect(readManifest("top")?.depends_on).toEqual([]);
  });
});