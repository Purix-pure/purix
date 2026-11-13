// A3-1 (research 04, D13) through the shared commit path every modify and ingest goes through.
// Real store, real lock, real files: nothing is stubbed.
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

const V0 = "export const a = 0;\n";
const V1 = "export const a = 1;\n";
const ADDED = "export const added = true;\n";

describe("commitVersionedChange: the writer's guarantees at the commit", () => {
  let root: string;
  let cwd: string;
  let entry: ManifestEntry;
  let savedExit: typeof process.exitCode;
  beforeEach(() => {
    cwd = process.cwd();
    savedExit = process.exitCode;
    root = realpathSync(mkdtempSync(join(tmpdir(), "purix-commit-writer-")));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.ts"), V0);
    process.chdir(root);
    entry = {
      component_id: "alpha", component_type: "module", current_version: 1, schema_version: 4,
      parts: { tools: [], config: {} }, files: ["src/a.ts"], depends_on: [], depended_on_by: [], version_history: [],
      verification_status: "pass", last_synced_hash: computeSyncHash([{ path: "src/a.ts", content: V0 }]),
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

  const params = (finalFiles: { path: string; new_content: string }[], newFilePaths?: string[]) => ({
    componentId: "alpha", entry, beforeSnapshot: [{ path: "src/a.ts", content: V0 }], finalFiles, operation: "diff_ingest",
    patchRef: "v2-test", contractChanged: false, provenance: { source_type: "external_diff" as const, source_agent: "test" },
    targetDir: root, reRunCommandHint: '"purix ingest"', ...(newFilePaths ? { newFilePaths } : {}),
  });

  it("lands a change that adds a file: the file exists, the component lists it, the journal is empty", async () => {
    const r = await commitVersionedChange(params([{ path: "src/a.ts", new_content: V1 }, { path: "src/new/added.ts", new_content: ADDED }], ["src/new/added.ts"]));
    expect(r.ok).toBe(true);
    expect(readFileSync(join(root, "src", "new", "added.ts"), "utf8")).toBe(ADDED);
    expect(readFileSync(join(root, "src", "a.ts"), "utf8")).toBe(V1);
    expect(readManifest("alpha")!.files).toEqual(["src/a.ts", "src/new/added.ts"]);
    expect(listPendingOperations()).toEqual([]);
  });

  it("refuses to overwrite a file a person edited after verification, writes nothing, and leaves no journal row", async () => {
    const err = mock.method(console, "error", () => {});
    try {
      writeFileSync(join(root, "src", "a.ts"), "export const a = 'edited by a person';\n");
      const r = await commitVersionedChange(params([{ path: "src/a.ts", new_content: V1 }, { path: "src/added.ts", new_content: ADDED }], ["src/added.ts"]));
      expect(r.ok).toBe(false);
      expect(process.exitCode).toBe(1);
      expect(String(err.mock.calls[0]!.arguments[0])).toMatch(/src\/a\.ts changed since it was verified/);
    } finally {
      err.mock.restore();
    }
    expect(readFileSync(join(root, "src", "a.ts"), "utf8")).toBe("export const a = 'edited by a person';\n");
    expect(existsSync(join(root, "src", "added.ts"))).toBe(false);
    expect(listPendingOperations()).toEqual([]);
    expect(readManifest("alpha")!.current_version).toBe(1);
  });

  it("writes nothing when this process does not hold the repository lock", async () => {
    releaseRepoLock(root);
    const err = mock.method(console, "error", () => {});
    try {
      const r = await commitVersionedChange(params([{ path: "src/a.ts", new_content: V1 }]));
      expect(r.ok).toBe(false);
      expect(String(err.mock.calls[0]!.arguments[0])).toMatch(/no longer holds the repository lock/);
    } finally {
      err.mock.restore();
    }
    expect(readFileSync(join(root, "src", "a.ts"), "utf8")).toBe(V0);
  });
});
