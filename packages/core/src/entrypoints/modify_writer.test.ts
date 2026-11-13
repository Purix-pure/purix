// A3-1 (research 04, D13): the writer.
//
// Before: applyModificationFiles read every target first, so a change that ADDS a file died with ENOENT; it wrote with a plain
// truncate-then-write; and it never asked whether the file still held what was verified, so a person's edit made between
// verification and the write was overwritten. Each test below states the defect it pins.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, chmodSync } from "node:fs";
import { writeFile as realWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyModificationFiles, rollbackModification, WriteAbortedError } from "./modify";
import { safeRmSync } from "../platform/fs_retry.js";

describe("applyModificationFiles: the writer", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "purix-writer-"));
  });
  afterEach(() => safeRmSync(dir));

  it("creates a file the change adds, in a folder that does not exist yet, byte for byte", async () => {
    const contents = ["export const a = 1;\n", "no final newline", "", "crlf\r\nlines\r\n", "ünïcode ✓\n"];
    const changes = contents.map((c, i) => ({ path: `src/new/deep${i}/f${i}.ts`, new_content: c }));
    await applyModificationFiles(changes, dir);
    for (const c of changes) expect(readFileSync(join(dir, c.path), "utf8")).toBe(c.new_content);
  });

  it("a mid-write failure removes the file it had just created and restores the one it had changed", async () => {
    writeFileSync(join(dir, "old.ts"), "old\n");
    let calls = 0;
    const failSecond = (async (...args: Parameters<typeof realWriteFile>) => {
      calls++;
      if (calls === 2) throw new Error("disk full");
      return realWriteFile(...args);
    }) as typeof realWriteFile;
    await expect(
      applyModificationFiles(
        [
          { path: "added.ts", new_content: "added\n" },
          { path: "old.ts", new_content: "changed\n" },
        ],
        dir,
        failSecond,
      ),
    ).rejects.toThrow(/disk full/);
    expect(existsSync(join(dir, "added.ts"))).toBe(false);
    expect(readFileSync(join(dir, "old.ts"), "utf8")).toBe("old\n");
  });

  it("keeps the permission bits of a file it replaces", async () => {
    if (process.platform === "win32") return;
    writeFileSync(join(dir, "run.sh"), "#!/bin/sh\n");
    chmodSync(join(dir, "run.sh"), 0o755);
    await applyModificationFiles([{ path: "run.sh", new_content: "#!/bin/sh\necho hi\n" }], dir);
    expect(statSync(join(dir, "run.sh")).mode & 0o777).toBe(0o755);
  });

  describe("a file changed by someone else since it was verified", () => {
    it("is never overwritten: nothing is written, and the error says which file", async () => {
      writeFileSync(join(dir, "a.ts"), "verified\n");
      writeFileSync(join(dir, "b.ts"), "b verified\n");
      writeFileSync(join(dir, "a.ts"), "a person edited this after verification\n");
      const err = await applyModificationFiles(
        [
          { path: "b.ts", new_content: "b new\n" },
          { path: "a.ts", new_content: "a new\n" },
        ],
        dir,
        undefined,
        { expectedBefore: [{ path: "a.ts", content: "verified\n" }, { path: "b.ts", content: "b verified\n" }] },
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(WriteAbortedError);
      expect((err as Error).message).toMatch(/a\.ts.*changed since/);
      expect(readFileSync(join(dir, "a.ts"), "utf8")).toBe("a person edited this after verification\n");
      expect(readFileSync(join(dir, "b.ts"), "utf8")).toBe("b verified\n"); // b was fine, and still was not written
    });

    it("includes a file that appeared where the change expected to add one", async () => {
      writeFileSync(join(dir, "new.ts"), "someone created this first\n");
      await expect(
        applyModificationFiles([{ path: "new.ts", new_content: "mine\n" }], dir, undefined, { expectedBefore: [] }),
      ).rejects.toBeInstanceOf(WriteAbortedError);
      expect(readFileSync(join(dir, "new.ts"), "utf8")).toBe("someone created this first\n");
    });

    it("is caught even when the edit lands between two of the writes: what was written is rolled back", async () => {
      writeFileSync(join(dir, "a.ts"), "a verified\n");
      writeFileSync(join(dir, "b.ts"), "b verified\n");
      let calls = 0;
      // the person edits b.ts right after a.ts has been written
      const editDuring = (async (...args: Parameters<typeof realWriteFile>) => {
        await realWriteFile(...args);
        if (++calls === 1) writeFileSync(join(dir, "b.ts"), "b edited by a person\n");
      }) as typeof realWriteFile;
      await expect(
        applyModificationFiles(
          [
            { path: "a.ts", new_content: "a new\n" },
            { path: "b.ts", new_content: "b new\n" },
          ],
          dir,
          editDuring,
          { expectedBefore: [{ path: "a.ts", content: "a verified\n" }, { path: "b.ts", content: "b verified\n" }] },
        ),
      ).rejects.toBeInstanceOf(WriteAbortedError);
      expect(readFileSync(join(dir, "a.ts"), "utf8")).toBe("a verified\n");
      expect(readFileSync(join(dir, "b.ts"), "utf8")).toBe("b edited by a person\n");
    });
  });

  it("refuses a path that leaves the project, and writes nothing", async () => {
    mkdirSync(join(dir, "proj"));
    await expect(
      applyModificationFiles(
        [
          { path: "ok.ts", new_content: "ok\n" },
          { path: "../escape.ts", new_content: "x\n" },
        ],
        join(dir, "proj"),
      ),
    ).rejects.toThrow(/outside the target directory/);
    expect(existsSync(join(dir, "proj", "ok.ts"))).toBe(false);
    expect(existsSync(join(dir, "escape.ts"))).toBe(false);
  });

  it("writes nothing when the lock check says this process no longer holds the repository lock", async () => {
    writeFileSync(join(dir, "a.ts"), "a\n");
    await expect(
      applyModificationFiles([{ path: "a.ts", new_content: "b\n" }], dir, undefined, {
        lockCheck: () => {
          throw new Error("lock lost");
        },
      }),
    ).rejects.toThrow(/lock lost/);
    expect(readFileSync(join(dir, "a.ts"), "utf8")).toBe("a\n");
  });

  it("rollbackModification deletes a file the change had added", async () => {
    writeFileSync(join(dir, "old.ts"), "old\n");
    const backups = await applyModificationFiles(
      [
        { path: "old.ts", new_content: "changed\n" },
        { path: "added.ts", new_content: "added\n" },
      ],
      dir,
    );
    await rollbackModification(backups);
    expect(readFileSync(join(dir, "old.ts"), "utf8")).toBe("old\n");
    expect(existsSync(join(dir, "added.ts"))).toBe(false);
  });
});
