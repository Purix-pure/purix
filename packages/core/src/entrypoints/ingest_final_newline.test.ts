// A3-2 (research 04 E2: 2 of 1,018 modified files differed from the real commit only in the final newline; found again on
// express commit c35284ee, .github/dependabot.yml). A modified file takes its final newline from the diff's two
// "\ No newline at end of file" markers: one on the old side, one on the new side. Nothing else about the result changes.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingestDiff } from "./ingest";
import { safeRmSync } from "../platform/fs_retry.js";

const NO_NL = "\\ No newline at end of file";
describe("ingestDiff: the final newline of a modified file", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "purix-eofnl-")); });
  afterEach(() => safeRmSync(dir));
  const run = async (before: string, diffLines: string[]) => {
    writeFileSync(join(dir, "f.txt"), before);
    const r = await ingestDiff(["--- a/f.txt", "+++ b/f.txt", ...diffLines, ""].join("\n"), null, dir);
    return r.ok ? r.files[0]!.new_content : `REFUSED: ${r.reason}`;
  };

  it("the old file had no final newline and the commit adds one (the express case)", async () => {
    expect(await run("a\nb", ["@@ -1,2 +1,2 @@", " a", "-b", NO_NL, "+b2"])).toBe("a\nb2\n");
  });
  it("the old file had a final newline and the commit removes it", async () => {
    expect(await run("a\nb\n", ["@@ -1,2 +1,2 @@", " a", "-b", "+b2", NO_NL])).toBe("a\nb2");
  });
  it("neither side has one and the last line is context: stays without", async () => {
    expect(await run("a\nb\nc", ["@@ -1,3 +1,3 @@", " a", "-b", "+B", " c", NO_NL])).toBe("a\nB\nc");
  });
  it("neither side has one and the last line changes: stays without", async () => {
    expect(await run("a\nb", ["@@ -1,2 +1,2 @@", " a", "-b", NO_NL, "+b2", NO_NL])).toBe("a\nb2");
  });
  it("only the last line's newline changes, same text", async () => {
    expect(await run("a\nb", ["@@ -1,2 +1,2 @@", " a", "-b", NO_NL, "+b"])).toBe("a\nb\n");
  });
  it("an ordinary change far from the end leaves the file's own ending alone", async () => {
    expect(await run("a\nb\nc\nd\ne\nf\ng\nh\ni\nj", ["@@ -1,3 +1,3 @@", " a", "-b", "+B", " c"])).toBe("a\nB\nc\nd\ne\nf\ng\nh\ni\nj");
    expect(await run("a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n", ["@@ -1,3 +1,3 @@", " a", "-b", "+B", " c"])).toBe("a\nB\nc\nd\ne\nf\ng\nh\ni\nj\n");
  });
});
