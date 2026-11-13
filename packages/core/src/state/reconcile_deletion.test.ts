// Plan 0.4: a crash during a change that deletes a file. The journal's after snapshot marks the file `deleted`, and "landed" for it
// means "absent". Each state a crash can leave is told apart from the two snapshots, and a person's edit is still never touched.
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

describe("reconcile: a crash around a deletion", () => {
  let root: string;
  let cwd: string;
  const A0 = "export const a = 0;\n";
  const A1 = "export const a = 1;\n";
  const B0 = "export const b = 0;\n";

  beforeEach(() => {
    cwd = process.cwd();
    root = realpathSync(mkdtempSync(join(tmpdir(), "purix-recon-del-")));
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
    createPendingOperation({
      component_id: "alpha", operation: "modify", new_version: 2, contract_changed: false,
      before_snapshot: [{ path: "src/a.ts", content: A0 }, { path: "src/b.ts", content: B0 }],
      // the change modifies a.ts and deletes b.ts
      after_snapshot: [{ path: "src/a.ts", content: A1 }, { path: "src/b.ts", content: "", deleted: true }],
    });
    acquireRepoLock(root);
  });
  afterEach(() => {
    releaseRepoLock(root);
    closeDb();
    process.chdir(cwd);
    safeRmSync(root);
  });

  it("nothing landed: the journal row is cleared and both files are as they were", async () => {
    await reconcilePendingOperations(root);
    expect(readFileSync(join(root, "src", "b.ts"), "utf8")).toBe(B0);
    expect(readFileSync(join(root, "src", "a.ts"), "utf8")).toBe(A0);
    expect(listPendingOperations()).toEqual([]);
  });

  it("the file was deleted but the other write never happened: the deleted file is restored", async () => {
    safeRmSync(join(root, "src", "b.ts"));
    await reconcilePendingOperations(root);
    expect(readFileSync(join(root, "src", "b.ts"), "utf8")).toBe(B0);
    expect(readFileSync(join(root, "src", "a.ts"), "utf8")).toBe(A0);
    expect(listPendingOperations()).toEqual([]);
  });

  it("the other file was written but the delete never happened: the write is undone", async () => {
    writeFileSync(join(root, "src", "a.ts"), A1);
    await reconcilePendingOperations(root);
    expect(readFileSync(join(root, "src", "a.ts"), "utf8")).toBe(A0);
    expect(existsSync(join(root, "src", "b.ts"))).toBe(true);
    expect(listPendingOperations()).toEqual([]);
  });

  it("a person recreated the deleted file with other content: nothing is touched, the row stays", async () => {
    writeFileSync(join(root, "src", "a.ts"), A1);
    writeFileSync(join(root, "src", "b.ts"), "export const b = 'a person wrote this';\n");
    await reconcilePendingOperations(root);
    expect(readFileSync(join(root, "src", "a.ts"), "utf8")).toBe(A1);
    expect(readFileSync(join(root, "src", "b.ts"), "utf8")).toBe("export const b = 'a person wrote this';\n");
    expect(listPendingOperations().length).toBe(1);
  });
});
