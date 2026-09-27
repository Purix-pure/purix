// src/entrypoints/ingest.test.ts
//
// Previously zero test coverage on this file (GAPS-REPORT-2 §5), despite
// it being the entry point for every external diff (PR patches, webhook
// payloads, upstream agent output). Covers the basic add/modify/delete
// paths, the path-traversal guard, the stale-base rejection for
// modifications, and the fix for the same protection being entirely
// absent from deletions.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingestDiff } from "./ingest";
import { safeRmSync } from "../platform/fs_retry.js";

describe("ingestDiff", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "purix-ingest-test-"));
  });

  afterEach(() => {
    safeRmSync(tmpDir);
  });

  it("rejects input with no recognizable diff section", async () => {
    const result = await ingestDiff("not a diff at all", null, tmpDir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/no recognizable unified-diff/);
  });

  describe("added files", () => {
    it("accepts a new file with no prior content on disk", async () => {
      const diff = [
        "--- /dev/null",
        "+++ b/new.ts",
        "@@ -0,0 +1,2 @@",
        "+export const x = 1;",
        "+export const y = 2;",
      ].join("\n");
      const result = await ingestDiff(diff, "human", tmpDir);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.files).toEqual([{ path: "new.ts", new_content: "export const x = 1;\nexport const y = 2;", status: "added" }]);
        expect(result.provenance).toEqual({ source_type: "external_diff", source_agent: "human" });
      }
    });
  });

  describe("modified files", () => {
    it("applies a hunk against the real file on disk", async () => {
      writeFileSync(join(tmpDir, "a.ts"), "line1\nline2\nline3\n");
      const diff = [
        "--- a/a.ts",
        "+++ b/a.ts",
        "@@ -1,3 +1,3 @@",
        " line1",
        "-line2",
        "+line2-changed",
        " line3",
      ].join("\n");
      const result = await ingestDiff(diff, null, tmpDir);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.files[0]?.new_content).toBe("line1\nline2-changed\nline3\n");
        expect(result.files[0]?.status).toBe("modified");
      }
    });

    it("fails closed when the diff's context doesn't match what's actually on disk (stale base)", async () => {
      writeFileSync(join(tmpDir, "a.ts"), "line1\nDIFFERENT\nline3\n");
      const diff = [
        "--- a/a.ts",
        "+++ b/a.ts",
        "@@ -1,3 +1,3 @@",
        " line1",
        "-line2",
        "+line2-changed",
        " line3",
      ].join("\n");
      const result = await ingestDiff(diff, null, tmpDir);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/doesn't match the file on disk/);
    });

    it("fails closed when the diff targets a file that isn't on disk", async () => {
      const diff = ["--- a/missing.ts", "+++ b/missing.ts", "@@ -1,1 +1,1 @@", "-old", "+new"].join("\n");
      const result = await ingestDiff(diff, null, tmpDir);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/isn't on disk/);
    });
  });

  describe("deleted files — regression for GAPS-REPORT-2 §5", () => {
    it("accepts a deletion whose hunk content matches what's on disk", async () => {
      writeFileSync(join(tmpDir, "gone.ts"), "line1\nline2\n");
      const diff = ["--- a/gone.ts", "+++ /dev/null", "@@ -1,2 +0,0 @@", "-line1", "-line2"].join("\n");
      const result = await ingestDiff(diff, null, tmpDir);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.files).toEqual([{ path: "gone.ts", new_content: "", status: "deleted" }]);
      }
    });

    it("rejects a deletion for a file that doesn't exist on disk, instead of accepting it unconditionally", async () => {
      const diff = ["--- a/never-existed.ts", "+++ /dev/null", "@@ -1,1 +0,0 @@", "-content"].join("\n");
      const result = await ingestDiff(diff, null, tmpDir);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toMatch(/isn't on disk/);
        expect(result.reason).toMatch(/refusing to accept a deletion/);
      }
    });

    it("rejects a deletion whose hunk content doesn't match the real file (stale-base protection, previously entirely absent for deletions)", async () => {
      // The diff claims the file being deleted contained "line1\nline2",
      // but the real file on disk has different content — e.g. it was
      // rewritten after this diff was generated. Before the fix, this
      // was accepted unconditionally: the deletion path never read the
      // file or checked its content at all.
      writeFileSync(join(tmpDir, "changed.ts"), "totally different content\n");
      const diff = ["--- a/changed.ts", "+++ /dev/null", "@@ -1,2 +0,0 @@", "-line1", "-line2"].join("\n");
      const result = await ingestDiff(diff, null, tmpDir);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/doesn't match the file on disk/);
    });

    it("still accepts a hunk-less deletion (some diff producers omit full content hunks) as long as the file exists", async () => {
      writeFileSync(join(tmpDir, "binary.png"), "fake binary content");
      const diff = ["--- a/binary.png", "+++ /dev/null"].join("\n");
      const result = await ingestDiff(diff, null, tmpDir);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.files).toEqual([{ path: "binary.png", new_content: "", status: "deleted" }]);
      }
    });
  });

  describe("path-traversal guard", () => {
    it("rejects a diff header path that escapes the target directory", async () => {
      const diff = ["--- a/../../../../etc/passwd", "+++ b/../../../../etc/passwd", "@@ -1,1 +1,1 @@", "-x", "+y"].join(
        "\n"
      );
      const result = await ingestDiff(diff, null, tmpDir);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/outside the target directory|resolves to/);
    });

    it("rejects a deletion whose path escapes the target directory (guard runs before the existence check)", async () => {
      // Real file exists elsewhere on the filesystem, but the diff's
      // path is still a traversal attempt relative to tmpDir — the
      // path-traversal guard must run and reject before the deletion
      // path's new file-existence check ever gets a chance to touch it.
      const outsideDir = mkdtempSync(join(tmpdir(), "purix-ingest-outside-"));
      try {
        writeFileSync(join(outsideDir, "secret.ts"), "real content\n");
        const diff = ["--- a/../secret.ts", "+++ /dev/null", "@@ -1,1 +0,0 @@", "-real content"].join("\n");
        const nestedTarget = join(tmpDir, "nested");
        mkdirSync(nestedTarget);
        const result = await ingestDiff(diff, null, nestedTarget);
        expect(result.ok).toBe(false);
      } finally {
        safeRmSync(outsideDir);
      }
    });
  });
});