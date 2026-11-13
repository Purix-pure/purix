// packages/core/src/manifest/library_chain.test.ts
//
// F05-10 (research 05, finding 10, experiment E8; decision D19, ADR-043).
// Before: the chain verified after plain inserts and failed ("Broken prev_hash", index 0) after
//   (a) re-promoting an existing entry, and (b) evicting the oldest entry. Nothing in production ever called verifyLibraryChain.
// Real SQLite in a throwaway folder, real library functions, no stubs. Linux only; no Windows run.
//
// The other half of the contract is kept here too: an edit made behind the library's back (raw SQL) must still be seen.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getDbCompat, writeManifest } from "./store.js";
import { promoteOperation, verifyLibraryChain, computeTaskSignature, clearLibrary, listLibrary, removeByComponentId } from "./library.js";
import type { ManifestEntry } from "./schema.js";
import { createConfigStore } from "../state/config.js";
import { appendAuditRecord } from "../security/audit_tamper_evidence.js";
import { computeSyncHash } from "../state/hash.js";
import { runCheck } from "../entrypoints/check.js";
import { safeRmSync } from "../platform/fs_retry.js";

let dir: string;
let oldCwd: string;

beforeEach(() => {
  oldCwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "purix-libchain-"));
  process.chdir(dir);
  clearLibrary();
});
afterEach(() => {
  closeDb();
  process.chdir(oldCwd);
  safeRmSync(dir);
});

function promote(n: number, over: { language?: string; edit?: string } = {}): string {
  const sig = computeTaskSignature(`comp-${n}`, "update_prompt_text", `change prompt ${n}`);
  promoteOperation({
    component_id: `comp-${n}`,
    operation: "update_prompt_text",
    task_signature: sig,
    description: `entry ${n}`,
    edits: [{ path: `a${n}.ts`, kind: "prompt_text", old_text: "a", new_text: over.edit ?? "b" }],
    ...(over.language ? { language: over.language } : {}),
  });
  return sig;
}

describe("the library chain stays valid through every change the library makes itself", () => {
  it("control: four plain inserts verify", () => {
    for (let i = 1; i <= 4; i++) promote(i);
    expect(verifyLibraryChain()).toEqual({ valid: true });
  });

  it("re-promoting an entry that is not the newest keeps the chain valid (E8: failed at index 0)", () => {
    for (let i = 1; i <= 4; i++) promote(i);
    promote(1, { edit: "changed" });
    expect(verifyLibraryChain()).toEqual({ valid: true });
    // The update really happened, and no entry was duplicated.
    const entries = listLibrary();
    expect(entries).toHaveLength(4);
    expect(entries.find((e) => e.component_id === "comp-1")!.edits[0]).toMatchObject({ new_text: "changed" });
  });

  it("re-promoting the newest entry keeps the chain valid", () => {
    for (let i = 1; i <= 3; i++) promote(i);
    promote(3, { edit: "again" });
    expect(verifyLibraryChain()).toEqual({ valid: true });
  });

  it("evicting at the ceiling keeps the chain valid (E8: failed at index 0)", () => {
    createConfigStore(dir).set("operationLibrary.maxEntries", 3);
    for (let i = 1; i <= 5; i++) promote(i);
    expect(listLibrary()).toHaveLength(3);
    expect(verifyLibraryChain()).toEqual({ valid: true });
  });

  it("evicting a row from the MIDDLE of the chain (least recently used is not always the oldest) keeps it valid", () => {
    createConfigStore(dir).set("operationLibrary.maxEntries", 3);
    for (let i = 1; i <= 3; i++) promote(i);
    // Make comp-1 and comp-3 recently used and comp-2 the least recently used.
    const db = getDbCompat();
    db.run(`UPDATE operation_library SET last_used_at = '2000-01-01T00:00:00.000Z' WHERE component_id = 'comp-2'`);
    promote(4); // at the ceiling: evicts comp-2, which sits between comp-1 and comp-3
    expect(listLibrary().map((e) => e.component_id).sort()).toEqual(["comp-1", "comp-3", "comp-4"]);
    expect(verifyLibraryChain()).toEqual({ valid: true });
  });

  it("removing a component's entries keeps the chain valid", () => {
    for (let i = 1; i <= 4; i++) promote(i);
    removeByComponentId("comp-2");
    expect(listLibrary()).toHaveLength(3);
    expect(verifyLibraryChain()).toEqual({ valid: true });
  });

  it("listing with verifyExistence, which deletes entries whose component is gone, keeps the chain valid", () => {
    for (let i = 1; i <= 3; i++) promote(i);
    writeFileSync(join(dir, "comp-1"), "x");
    writeFileSync(join(dir, "comp-3"), "x");
    // comp-2 has no file: it is removed from the middle.
    expect(listLibrary({ verifyExistence: true }).map((e) => e.component_id).sort()).toEqual(["comp-1", "comp-3"]);
    expect(verifyLibraryChain()).toEqual({ valid: true });
  });

  it("with entries in two languages, verifying without a language checks each language's own chain", () => {
    promote(1, { language: "typescript" });
    promote(2, { language: "python" });
    promote(3, { language: "typescript" });
    promote(4, { language: "python" });
    expect(verifyLibraryChain()).toEqual({ valid: true });
    expect(verifyLibraryChain("python")).toEqual({ valid: true });
  });
});

describe("a change made behind the library's back is still seen", () => {
  it("editing a stored edit by hand is reported as a hash mismatch", () => {
    for (let i = 1; i <= 3; i++) promote(i);
    getDbCompat().run(`UPDATE operation_library SET edits = '[]' WHERE component_id = 'comp-2'`);
    const r = verifyLibraryChain();
    expect(r.valid).toBe(false);
    expect(r.compromisedIndex).toBe(1);
    expect(r.reason).toMatch(/tamper/);
  });

  it("deleting a middle row by hand is reported as a broken link", () => {
    for (let i = 1; i <= 4; i++) promote(i);
    getDbCompat().run(`DELETE FROM operation_library WHERE component_id = 'comp-2'`);
    const r = verifyLibraryChain();
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/Broken prev_hash/);
  });

  it("a legitimate change after a hand edit does not hide it", () => {
    for (let i = 1; i <= 3; i++) promote(i);
    getDbCompat().run(`UPDATE operation_library SET edits = '[]' WHERE component_id = 'comp-1'`);
    promote(4);
    expect(verifyLibraryChain().valid).toBe(false);
  });
});

describe("purix check reports the library chain", () => {
  const SRC = "export const a = 1;\n";
  function governed(): void {
    writeFileSync(join(dir, "a.ts"), SRC);
    const entry: ManifestEntry = {
      component_id: "comp-a", component_type: "module", current_version: 1, schema_version: 5, parts: { tools: [], config: {} }, files: ["a.ts"],
      depends_on: [], depended_on_by: [], version_history: [], verification_status: "pass", last_synced_hash: computeSyncHash([{ path: "a.ts", content: SRC }]),
    };
    writeManifest(entry);
    appendAuditRecord({ event: "test_setup" });
  }
  const libraryItems = () => runCheck({ baseDir: dir }).sections.flatMap((s) => s.items).filter((i) => i.subject === "operation library");

  it("says nothing when the chain is intact", () => {
    for (let i = 1; i <= 3; i++) promote(i);
    governed();
    closeDb();
    expect(libraryItems()).toEqual([]);
  });

  it("fails, naming the library, when an entry was edited by hand", () => {
    for (let i = 1; i <= 3; i++) promote(i);
    governed();
    getDbCompat().run(`UPDATE operation_library SET edits = '[]' WHERE component_id = 'comp-2'`);
    closeDb();
    const items = libraryItems();
    expect(items).toHaveLength(1);
    expect(items[0]!.outcome).toBe("fail");
    expect(items[0]!.message).toMatch(/tamper|Broken prev_hash/);
    expect(runCheck({ baseDir: dir }).exitCode).toBe(1);
  });

  it("is quiet and creates nothing when the store has no library table at all", () => {
    governed();
    getDbCompat().run(`DROP TABLE IF EXISTS operation_library`); // beforeEach created it
    closeDb();
    expect(libraryItems()).toEqual([]);
    const row = getDbCompat().query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'operation_library'`).get();
    expect(row).toBeFalsy();
  });
});
