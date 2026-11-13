// A2b-1 (research 11, D14): reconcile runs only while this process holds the repository lock.
//
// Before: the pre-action step of every mutating command called reconcilePendingOperations() and only then took the lock.
// A second command therefore rolled back, or "completed", an operation that a live first process was in the middle of, and
// was refused by the lock afterwards (12 of 12 forced runs ended inconsistent in research 11). A journal row can only be
// abandoned if its writer has lost the lock, so with the lock held every pending row is stale by construction.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconcilePendingOperations } from "./reconcile";
import { acquireRepoLock, releaseRepoLock } from "./repo_lock";
import { closeDb, createPendingOperation, listPendingOperations, writeManifest } from "../manifest/store";
import { computeSyncHash } from "./hash";
import { safeRmSync } from "../platform/fs_retry.js";
import type { ManifestEntry } from "../manifest/schema";

const BEFORE = "export const a = 1;\n";
const AFTER = "export const a = 2;\n";

describe("reconcilePendingOperations and the repository lock", () => {
  let root: string;
  let cwd: string;
  let opId: string;
  beforeEach(() => {
    cwd = process.cwd();
    root = realpathSync(mkdtempSync(join(tmpdir(), "purix-reconcile-lock-")));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.ts"), BEFORE);
    process.chdir(root);
    writeManifest({
      component_id: "alpha", component_type: "module", current_version: 1, schema_version: 4,
      parts: { tools: [], config: {} }, files: ["src/a.ts"], depends_on: [], depended_on_by: [], version_history: [],
      verification_status: "pass", last_synced_hash: computeSyncHash([{ path: "src/a.ts", content: BEFORE }]),
    } as unknown as ManifestEntry);
    // An operation whose write has not landed yet: the journal row exists, the file still has the old content.
    opId = createPendingOperation({
      component_id: "alpha", operation: "modify", new_version: 2, contract_changed: false,
      before_snapshot: [{ path: "src/a.ts", content: BEFORE }], after_snapshot: [{ path: "src/a.ts", content: AFTER }],
    });
  });
  afterEach(() => {
    releaseRepoLock(root);
    closeDb();
    process.chdir(cwd);
    safeRmSync(root);
  });

  it("without the lock it changes nothing: the journal row stays and the files are untouched", async () => {
    await reconcilePendingOperations(root);
    expect(listPendingOperations().map((o) => o.id)).toEqual([opId]);
    expect(readFileSync(join(root, "src", "a.ts"), "utf8")).toBe(BEFORE);
  });

  it("with the lock it resolves the stale row as before", async () => {
    acquireRepoLock(root);
    await reconcilePendingOperations(root);
    expect(listPendingOperations()).toEqual([]);
    expect(readFileSync(join(root, "src", "a.ts"), "utf8")).toBe(BEFORE);
  });

  it("when another process holds the lock, this one never gets as far as reconciling", async () => {
    // the lock is held by this very pid under a token that is not ours: heldToken is null, so isRepoLockHeld is false
    const now = new Date().toISOString();
    mkdirSync(join(root, ".purix"), { recursive: true });
    writeFileSync(join(root, ".purix", "repo.lock"), JSON.stringify({ pid: process.pid, timestamp: now, updatedAt: now, token: "someone-else" }));
    await reconcilePendingOperations(root);
    expect(listPendingOperations().map((o) => o.id)).toEqual([opId]);
  });
});
