// Plan 0.4: the writer deletes a file the way it writes one: only if it still holds what was verified, and undoable.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { writeFile as realWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyModificationFiles, rollbackModification, WriteAbortedError } from "./modify";
import { safeRmSync } from "../platform/fs_retry.js";

describe("applyModificationFiles: deleting", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "purix-writer-del-"));
    writeFileSync(join(dir, "a.ts"), "a0\n");
    writeFileSync(join(dir, "b.ts"), "b0\n");
  });
  afterEach(() => safeRmSync(dir));
  const expectedBefore = () => [{ path: "a.ts", content: "a0\n" }, { path: "b.ts", content: "b0\n" }];

  it("writes one file and removes another in the same change", async () => {
    await applyModificationFiles([{ path: "a.ts", new_content: "a1\n" }, { path: "b.ts", new_content: "", delete: true }], dir, undefined, { expectedBefore: expectedBefore() });
    expect(readFileSync(join(dir, "a.ts"), "utf8")).toBe("a1\n");
    expect(existsSync(join(dir, "b.ts"))).toBe(false);
  });

  it("does not remove a file a person edited after verification, and writes nothing", async () => {
    writeFileSync(join(dir, "b.ts"), "edited by a person\n");
    await expect(
      applyModificationFiles([{ path: "a.ts", new_content: "a1\n" }, { path: "b.ts", new_content: "", delete: true }], dir, undefined, { expectedBefore: expectedBefore() }),
    ).rejects.toBeInstanceOf(WriteAbortedError);
    expect(readFileSync(join(dir, "b.ts"), "utf8")).toBe("edited by a person\n");
    expect(readFileSync(join(dir, "a.ts"), "utf8")).toBe("a0\n");
  });

  it("a failure after the delete puts the deleted file back with its content", async () => {
    let calls = 0;
    const failOnWrite = (async (...args: Parameters<typeof realWriteFile>) => {
      calls++;
      // the delete is the first change and needs no write; the second change's write fails; the rollback's writes go through
      if (calls === 1) throw new Error("disk full");
      return realWriteFile(...args);
    }) as typeof realWriteFile;
    await expect(
      applyModificationFiles([{ path: "b.ts", new_content: "", delete: true }, { path: "a.ts", new_content: "a1\n" }], dir, failOnWrite, { expectedBefore: expectedBefore() }),
    ).rejects.toThrow(/disk full/);
    expect(readFileSync(join(dir, "b.ts"), "utf8")).toBe("b0\n");
    expect(readFileSync(join(dir, "a.ts"), "utf8")).toBe("a0\n");
  });

  it("rollbackModification restores a deleted file", async () => {
    const backups = await applyModificationFiles([{ path: "b.ts", new_content: "", delete: true }], dir, undefined, { expectedBefore: expectedBefore() });
    expect(existsSync(join(dir, "b.ts"))).toBe(false);
    await rollbackModification(backups);
    expect(readFileSync(join(dir, "b.ts"), "utf8")).toBe("b0\n");
  });

  it("refuses a path that leaves the project, deleting or not", async () => {
    await expect(applyModificationFiles([{ path: "../outside.ts", new_content: "", delete: true }], dir)).rejects.toBeInstanceOf(WriteAbortedError);
  });
});
