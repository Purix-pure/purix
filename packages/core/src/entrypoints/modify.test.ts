// src/entrypoints/modify.test.ts
//
// Previously zero test coverage on this file (GAPS-REPORT-2 §3), despite
// it being the file-write path every direct-patch modification goes
// through. Covers the happy path, a clean rollback on mid-write failure,
// and the fix for the rollback-failure-swallowed bug.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { writeFile as realWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readComponentFiles, applyModificationFiles, rollbackModification } from "./modify";
import type { ManifestEntry } from "../manifest/schema";
import { safeRmSync } from "../platform/fs_retry.js";

describe("modify.ts", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "purix-modify-test-"));
  });

  afterEach(() => {
    safeRmSync(tmpDir);
  });

  describe("readComponentFiles", () => {
    it("reads every listed file's content", async () => {
      writeFileSync(join(tmpDir, "a.ts"), "export const a = 1;\n");
      writeFileSync(join(tmpDir, "b.ts"), "export const b = 2;\n");
      const entry = { files: ["a.ts", "b.ts"] } as ManifestEntry;
      const files = await readComponentFiles(entry, tmpDir);
      expect(files).toEqual([
        { path: "a.ts", content: "export const a = 1;\n" },
        { path: "b.ts", content: "export const b = 2;\n" },
      ]);
    });

    it("skips a listed file that's missing on disk rather than throwing", async () => {
      writeFileSync(join(tmpDir, "a.ts"), "export const a = 1;\n");
      const entry = { files: ["a.ts", "missing.ts"] } as ManifestEntry;
      const files = await readComponentFiles(entry, tmpDir);
      expect(files).toEqual([{ path: "a.ts", content: "export const a = 1;\n" }]);
    });
  });

  describe("applyModificationFiles — happy path", () => {
    it("writes every change and returns a backup of each file's previous content", async () => {
      writeFileSync(join(tmpDir, "a.ts"), "old a\n");
      writeFileSync(join(tmpDir, "b.ts"), "old b\n");

      const backups = await applyModificationFiles(
        [
          { path: "a.ts", new_content: "new a\n" },
          { path: "b.ts", new_content: "new b\n" },
        ],
        tmpDir
      );

      expect(readFileSync(join(tmpDir, "a.ts"), "utf-8")).toBe("new a\n");
      expect(readFileSync(join(tmpDir, "b.ts"), "utf-8")).toBe("new b\n");
      expect(backups).toEqual([
        { path: "a.ts", fullPath: join(tmpDir, "a.ts"), previousContent: "old a\n" },
        { path: "b.ts", fullPath: join(tmpDir, "b.ts"), previousContent: "old b\n" },
      ]);
    });
  });

  describe("applyModificationFiles — rollback on mid-write failure", () => {
    it("rolls back every file already written before re-throwing the original error", async () => {
      writeFileSync(join(tmpDir, "a.ts"), "old a\n");
      writeFileSync(join(tmpDir, "b.ts"), "old b\n");
      writeFileSync(join(tmpDir, "c.ts"), "old c\n");

      // Injected writeFile: succeeds for a.ts and b.ts, fails for c.ts —
      // simulating a mid-loop failure (disk full, permissions, etc.)
      // after some files have already been written.
      const flakyWrite: typeof realWriteFile = (async (path: any, content: any, ...rest: any[]) => {
        if (String(path).endsWith("c.ts")) {
          throw new Error("simulated disk error writing c.ts");
        }
        return realWriteFile(path, content, ...rest);
      }) as typeof realWriteFile;

      let caught: unknown;
      try {
        await applyModificationFiles(
          [
            { path: "a.ts", new_content: "new a\n" },
            { path: "b.ts", new_content: "new b\n" },
            { path: "c.ts", new_content: "new c\n" },
          ],
          tmpDir,
          flakyWrite
        );
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeTruthy();
      expect((caught as Error).message).toContain("simulated disk error writing c.ts");
      // a.ts and b.ts were written, then rolled back; c.ts's write never
      // succeeded in the first place.
      expect(readFileSync(join(tmpDir, "a.ts"), "utf-8")).toBe("old a\n");
      expect(readFileSync(join(tmpDir, "b.ts"), "utf-8")).toBe("old b\n");
      expect(readFileSync(join(tmpDir, "c.ts"), "utf-8")).toBe("old c\n");
    });
  });

  describe("applyModificationFiles — rollback failure is surfaced, not swallowed (GAPS-REPORT-2 §3)", () => {
    it("throws a composite error naming which files failed to roll back, instead of only the original write error", async () => {
      writeFileSync(join(tmpDir, "a.ts"), "old a\n");
      writeFileSync(join(tmpDir, "b.ts"), "old b\n");
      writeFileSync(join(tmpDir, "c.ts"), "old c\n");

      // Injected writeFile: a.ts and b.ts succeed on their FIRST call
      // (the forward pass) but a.ts fails on its SECOND call (the
      // rollback pass, writing its previousContent back) — this is
      // exactly the "succeeds now, fails specifically on rollback"
      // scenario that a real filesystem can't be made to do
      // deterministically without racing the code under test. c.ts
      // fails immediately, triggering the rollback in the first place.
      const callCounts = new Map<string, number>();
      const flakyWrite: typeof realWriteFile = (async (path: any, content: any, ...rest: any[]) => {
        const key = String(path);
        const n = (callCounts.get(key) ?? 0) + 1;
        callCounts.set(key, n);
        if (key.endsWith("c.ts")) {
          throw new Error("simulated disk error writing c.ts");
        }
        if (key.endsWith("a.ts") && n === 2) {
          throw new Error("simulated disk error rolling back a.ts");
        }
        return realWriteFile(path, content, ...rest);
      }) as typeof realWriteFile;

      let caught: any;
      try {
        await applyModificationFiles(
          [
            { path: "a.ts", new_content: "new a\n" },
            { path: "b.ts", new_content: "new b\n" },
            { path: "c.ts", new_content: "new c\n" },
          ],
          tmpDir,
          flakyWrite
        );
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeTruthy();
      // The composite error must name the file that failed to roll back
      // — this is exactly the signal that used to be silently discarded.
      expect(caught.message).toContain("rollback failed");
      expect(caught.message).toContain("a.ts");
      expect(caught.rollbackFailures).toBeTruthy();
      expect(caught.rollbackFailures.some((f: any) => f.path === "a.ts")).toBe(true);
      // a.ts's forward write DID succeed (it's the rollback that
      // failed), so it's sitting on disk with the new, uncommitted
      // content — exactly the inconsistent state the error message
      // needs to warn about.
      expect(readFileSync(join(tmpDir, "a.ts"), "utf-8")).toBe("new a\n");
      // b.ts's rollback succeeded independently of a.ts's failure.
      expect(readFileSync(join(tmpDir, "b.ts"), "utf-8")).toBe("old b\n");
    });
  });

  describe("rollbackModification", () => {
    it("restores every backed-up file's previous content", async () => {
      writeFileSync(join(tmpDir, "a.ts"), "changed a\n");
      writeFileSync(join(tmpDir, "b.ts"), "changed b\n");

      await rollbackModification([
        { path: "a.ts", fullPath: join(tmpDir, "a.ts"), previousContent: "original a\n" },
        { path: "b.ts", fullPath: join(tmpDir, "b.ts"), previousContent: "original b\n" },
      ]);

      expect(readFileSync(join(tmpDir, "a.ts"), "utf-8")).toBe("original a\n");
      expect(readFileSync(join(tmpDir, "b.ts"), "utf-8")).toBe("original b\n");
    });
  });
});