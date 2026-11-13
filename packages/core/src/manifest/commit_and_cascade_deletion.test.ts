// Plan 0.4: a change that deletes files, through the shared commit path. Real store, real lock, real files.
import { describe, it, beforeEach, afterEach, mock } from "node:test";
import { expect } from "expect";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitVersionedChange } from "./commit_and_cascade";
import { closeDb, listPendingOperations, readManifest, writeManifest } from "./store";
import { acquireRepoLock, releaseRepoLock } from "../state/repo_lock";
import { computeSyncHash } from "../state/hash";
import { safeRmSync } from "../platform/fs_retry.js";
import type { ManifestEntry } from "./schema";

const A0 = "export const a = 0;\n";
const A1 = "export const a = 1;\n";
const B0 = "export const b = 0;\n";

describe("commitVersionedChange: deleting a file", () => {
  let root: string;
  let cwd: string;
  let entry: ManifestEntry;
  let savedExit: typeof process.exitCode;
  beforeEach(() => {
    cwd = process.cwd();
    savedExit = process.exitCode;
    root = realpathSync(mkdtempSync(join(tmpdir(), "purix-commit-delete-")));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.ts"), A0);
    writeFileSync(join(root, "src", "b.ts"), B0);
    process.chdir(root);
    entry = {
      component_id: "alpha", component_type: "module", current_version: 1, schema_version: 4,
      parts: { tools: [], config: {} }, files: ["src/a.ts", "src/b.ts"], depends_on: [], depended_on_by: [], version_history: [],
      verification_status: "pass",
      last_synced_hash: computeSyncHash([{ path: "src/a.ts", content: A0 }, { path: "src/b.ts", content: B0 }]),
    } as unknown as ManifestEntry;
    writeManifest(entry);
    acquireRepoLock(root);
  });
  afterEach(() => {
    process.exitCode = savedExit;
    releaseRepoLock(root);
    closeDb();
    process.chdir(cwd);
    safeRmSync(root);
  });

  const params = () => ({
    componentId: "alpha", entry,
    beforeSnapshot: [{ path: "src/a.ts", content: A0 }, { path: "src/b.ts", content: B0 }],
    finalFiles: [{ path: "src/a.ts", new_content: A1 }],
    deletedPaths: ["src/b.ts"],
    operation: "diff_ingest", patchRef: "v2-test", contractChanged: false,
    provenance: { source_type: "external_diff" as const, source_agent: "test" },
    targetDir: root, reRunCommandHint: '"purix ingest"',
  });

  it("removes the file from disk and from the component, and hashes only what remains", async () => {
    const r = await commitVersionedChange(params());
    expect(r.ok).toBe(true);
    expect(existsSync(join(root, "src", "b.ts"))).toBe(false);
    expect(readFileSync(join(root, "src", "a.ts"), "utf8")).toBe(A1);
    const saved = readManifest("alpha")!;
    expect(saved.files).toEqual(["src/a.ts"]);
    expect(saved.current_version).toBe(2);
    expect(saved.last_synced_hash).toBe(computeSyncHash([{ path: "src/a.ts", content: A1 }]));
    expect(listPendingOperations()).toEqual([]);
  });

  it("refuses to delete a file a person edited after verification: nothing is removed or written", async () => {
    const err = mock.method(console, "error", () => {});
    try {
      writeFileSync(join(root, "src", "b.ts"), "export const b = 'edited by a person';\n");
      const r = await commitVersionedChange(params());
      expect(r.ok).toBe(false);
      expect(String(err.mock.calls[0]!.arguments[0])).toMatch(/src\/b\.ts changed since it was verified/);
    } finally {
      err.mock.restore();
    }
    expect(readFileSync(join(root, "src", "b.ts"), "utf8")).toBe("export const b = 'edited by a person';\n");
    expect(readFileSync(join(root, "src", "a.ts"), "utf8")).toBe(A0);
    expect(readManifest("alpha")!.files).toEqual(["src/a.ts", "src/b.ts"]);
    expect(listPendingOperations()).toEqual([]);
  });

});
