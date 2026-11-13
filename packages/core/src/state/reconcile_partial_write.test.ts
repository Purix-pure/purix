// A3-1 (research 04, D13): a crash between two file writes.
//
// A change that touches two files writes them one after the other. A crash in between leaves one file new and the other old,
// which matched neither the journal's "before" nor its "after" snapshot, so reconcile said "refusing to guess" and left the
// project half-changed. Every file is either exactly its before content or exactly its after content, so the two snapshots are
// enough to tell: nothing else touched anything, and the change can be undone cleanly. A file with a third content is somebody
// else's work, and that is still refused.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconcilePendingOperations } from "./reconcile";
import { acquireRepoLock, releaseRepoLock } from "./repo_lock";
import { closeDb, createPendingOperation, listPendingOperations, writeManifest } from "../manifest/store";
import { computeSyncHash } from "./hash";
import { safeRmSync } from "../platform/fs_retry.js";
import type { ManifestEntry } from "../manifest/schema";

describe("reconcile: a crash between two writes", () => {
  let root: string;
  let cwd: string;
  let opId: string;
  const A0 = "export const a = 0;\n";
  const A1 = "export const a = 1;\n";
  const B0 = "export const b = 0;\n";
  const B1 = "export const b = 1;\n";
  const NEW = "export const added = 1;\n";

  beforeEach(() => {
    cwd = process.cwd();
    root = realpathSync(mkdtempSync(join(tmpdir(), "purix-partial-")));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.ts"), A0);
    writeFileSync(join(root, "src", "b.ts"), B0);
    process.chdir(root);
    writeManifest({
      component_id: "alpha", component_type: "module", current_version: 1, schema_version: 4,
      parts: { tools: [], config: {} }, files: ["src/a.ts", "src/b.ts"], depends_on: [], depended_on_by: [], version_history: [],
      verification_status: "pass",
      last_synced_hash: computeSyncHash([{ path: "src/a.ts", content: A0 }, { path: "src/b.ts", content: B0 }]),
    } as unknown as ManifestEntry);
    opId = createPendingOperation({
      component_id: "alpha", operation: "modify", new_version: 2, contract_changed: false,
      before_snapshot: [{ path: "src/a.ts", content: A0 }, { path: "src/b.ts", content: B0 }],
      // the change modifies a.ts and b.ts and adds src/added.ts
      after_snapshot: [{ path: "src/a.ts", content: A1 }, { path: "src/b.ts", content: B1 }, { path: "src/added.ts", content: NEW }],
    });
    acquireRepoLock(root);
  });
  afterEach(() => {
    releaseRepoLock(root);
    closeDb();
    process.chdir(cwd);
    safeRmSync(root);
  });

  it("first file written, second not: rolled back to the before state, journal row cleared", async () => {
    writeFileSync(join(root, "src", "a.ts"), A1);
    await reconcilePendingOperations(root);
    expect(readFileSync(join(root, "src", "a.ts"), "utf8")).toBe(A0);
    expect(readFileSync(join(root, "src", "b.ts"), "utf8")).toBe(B0);
    expect(existsSync(join(root, "src", "added.ts"))).toBe(false);
    expect(listPendingOperations()).toEqual([]);
  });

  it("only the added file was written: it is removed, and nothing else changes", async () => {
    writeFileSync(join(root, "src", "added.ts"), NEW);
    await reconcilePendingOperations(root);
    expect(existsSync(join(root, "src", "added.ts"))).toBe(false);
    expect(readFileSync(join(root, "src", "a.ts"), "utf8")).toBe(A0);
    expect(listPendingOperations()).toEqual([]);
  });

  it("a file with a third content is somebody else's work: nothing is touched, the row stays for a person", async () => {
    writeFileSync(join(root, "src", "a.ts"), A1);
    writeFileSync(join(root, "src", "b.ts"), "export const b = 'a person edited this';\n");
    await reconcilePendingOperations(root);
    expect(readFileSync(join(root, "src", "a.ts"), "utf8")).toBe(A1);
    expect(readFileSync(join(root, "src", "b.ts"), "utf8")).toBe("export const b = 'a person edited this';\n");
    expect(listPendingOperations().map((o) => o.id)).toEqual([opId]);
  });

  it("a change that landed completely but fails verification is undone including the file it added", async () => {
    const BROKEN = "export const = ;\n"; // fails verification wherever it runs
    writeFileSync(join(root, "src", "a.ts"), BROKEN);
    writeFileSync(join(root, "src", "b.ts"), B1);
    writeFileSync(join(root, "src", "added.ts"), NEW);
    // the journal row of this test's beforeEach says a.ts becomes A1; this operation says it becomes BROKEN
    const op = listPendingOperations().find((o) => o.id === opId)!;
    const { deletePendingOperation } = await import("../manifest/store");
    deletePendingOperation(op.id);
    createPendingOperation({
      component_id: "alpha", operation: "modify", new_version: 2, contract_changed: false,
      before_snapshot: [{ path: "src/a.ts", content: A0 }, { path: "src/b.ts", content: B0 }],
      after_snapshot: [{ path: "src/a.ts", content: BROKEN }, { path: "src/b.ts", content: B1 }, { path: "src/added.ts", content: NEW }],
    });
    await reconcilePendingOperations(root);
    expect(readFileSync(join(root, "src", "a.ts"), "utf8")).toBe(A0);
    expect(readFileSync(join(root, "src", "b.ts"), "utf8")).toBe(B0);
    expect(existsSync(join(root, "src", "added.ts"))).toBe(false);
    expect(listPendingOperations()).toEqual([]);
  });
});
