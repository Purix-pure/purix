// A3-1 (research 04): a diff whose line numbers are off because the file moved on (lines added or removed above the change) still
// applies when the lines it wants to change are found exactly once nearby, the way patch(1) does. 0 of 1,018 shifted hunks were
// accepted before. What must stay true: the old side of the hunk has to match exactly, a block that matches in two places is
// refused (it could be either), and a hunk with no old-side lines (a bare insertion) has nothing to anchor on and is never moved.
//
// The 1,018-file replay corpus of research 04 was never uploaded; these tests use generated files, so they show the mechanism at
// shifts 0, 1, 3 and 10, not the corpus rate.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingestDiff } from "./ingest";
import { safeRmSync } from "../platform/fs_retry.js";

const lines = (n: number, prefix = "line"): string[] => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`);

/** A one-hunk diff replacing "line 50" with "CHANGED 50", written as if the file had `claimedAt` lines above it. */
function replaceDiff(claimedAt: number): string {
  return [
    "--- a/f.txt", "+++ b/f.txt", `@@ -${claimedAt - 2},5 +${claimedAt - 2},5 @@`,
    " line 48", " line 49", "-line 50", "+CHANGED 50", " line 51", " line 52", "",
  ].join("\n");
}

describe("ingestDiff: hunks whose line numbers are off", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "purix-shift-"));
  });
  afterEach(() => safeRmSync(dir));

  const apply = async (content: string, diff: string) => {
    writeFileSync(join(dir, "f.txt"), content);
    return ingestDiff(diff, null, dir);
  };
  const expected = (base: string[]) => base.map((l) => (l === "line 50" ? "CHANGED 50" : l)).join("\n");

  for (const shift of [0, 1, 3, 10]) {
    it(`applies a hunk that is ${shift} line(s) off, to the right lines`, async () => {
      // the file has `shift` extra lines at the top, so "line 50" now sits at 50 + shift; the diff still says 50
      const real = [...lines(shift, "extra"), ...lines(100)];
      const r = await apply(real.join("\n") + "\n", replaceDiff(50));
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.files[0]!.new_content).toBe(expected(real) + "\n");
    });
  }

  it("applies a hunk that is off in the other direction (lines were removed above it)", async () => {
    const real = lines(100).slice(5); // line 50 now sits 5 lines higher
    const r = await apply(real.join("\n") + "\n", replaceDiff(50));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.files[0]!.new_content).toBe(expected(real) + "\n");
  });

  it("carries the offset to the hunks after it", async () => {
    const real = [...lines(4, "extra"), ...lines(100)];
    const diff = [
      "--- a/f.txt", "+++ b/f.txt",
      "@@ -10,3 +10,3 @@", " line 10", "-line 11", "+CHANGED 11", " line 12",
      "@@ -60,3 +60,3 @@", " line 60", "-line 61", "+CHANGED 61", " line 62", "",
    ].join("\n");
    const r = await apply(real.join("\n") + "\n", diff);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const out = r.files[0]!.new_content.split("\n");
      expect(out).toContain("CHANGED 11");
      expect(out).toContain("CHANGED 61");
      expect(out.filter((l) => l.startsWith("CHANGED")).length).toBe(2);
      expect(out.length).toBe(real.length + 1); // trailing "" of the final newline
    }
  });

  it("refuses a hunk whose old side is found in two places: it could be either", async () => {
    const real = [...lines(3), "line 48", "line 49", "line 50", "line 51", "line 52", ...lines(10), "line 48", "line 49", "line 50", "line 51", "line 52"];
    const r = await apply(real.join("\n") + "\n", replaceDiff(150));
    expect(r.ok).toBe(false);
  });

  it("refuses a hunk whose old side is not in the file at all", async () => {
    const r = await apply(lines(100, "other").join("\n") + "\n", replaceDiff(50));
    expect(r.ok).toBe(false);
  });

  it("no fixed distance: a hunk far from its stated line still applies when its block is unique in the file", async () => {
    const real = [...lines(300, "extra"), ...lines(100)];
    const r = await apply(real.join("\n") + "\n", replaceDiff(50));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.files[0]!.new_content.split("\n")[349]).toBe("CHANGED 50"); // 300 extra + line 50 at index 49
  });

  it("refuses when the same block also appears far away, outside any old search window", async () => {
    const real = [...lines(100), ...lines(400, "filler"), "line 48", "line 49", "line 50", "line 51", "line 52"];
    const r = await apply(real.join("\n") + "\n", replaceDiff(150));
    expect(r.ok).toBe(false);
  });

  it("never moves a bare insertion: with nothing to anchor on, the line number is all there is", async () => {
    const real = [...lines(4, "extra"), ...lines(100)];
    const diff = ["--- a/f.txt", "+++ b/f.txt", "@@ -50,0 +51,1 @@", "+inserted", ""].join("\n");
    const r = await apply(real.join("\n") + "\n", diff);
    if (r.ok) {
      // it may apply at the stated line, but never somewhere else: the inserted line sits right after line 50 of the file as given
      const out = r.files[0]!.new_content.split("\n");
      expect(out.indexOf("inserted")).toBe(49);
    }
  });

  // Minimum anchor size: fewer than 3 non-blank old-side lines is not enough to move a hunk by position alone.
  const thinDiff = (at: number) => ["--- a/f.txt", "+++ b/f.txt", `@@ -${at},2 +${at},2 @@`, " line 50", "-line 51", "+CHANGED 51", ""].join("\n");

  it("refuses to move a thin hunk (fewer than 3 non-blank old lines) that sits mid-file at the wrong line number", async () => {
    const real = [...lines(4, "extra"), ...lines(100)];
    const r = await apply(real.join("\n") + "\n", thinDiff(50));
    expect(r.ok).toBe(false);
  });

  it("still applies a thin hunk at the line its header gives (no move needed)", async () => {
    const r = await apply(lines(100).join("\n") + "\n", thinDiff(50));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.files[0]!.new_content.split("\n")[50]).toBe("CHANGED 51");
  });

  it("moves a thin hunk that sits flush against the end of the file (where less context is normal)", async () => {
    const real = [...lines(3, "extra"), ...lines(51)]; // \"line 50\", \"line 51\" are the last two lines
    const r = await apply(real.join("\n") + "\n", thinDiff(50));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.files[0]!.new_content).toBe(real.map((l) => (l === "line 51" ? "CHANGED 51" : l)).join("\n") + "\n");
  });

  it("does not count blank lines toward the minimum", async () => {
    const real = [...lines(4, "extra"), "", "", "line 50", ...lines(60).slice(50)];
    const diff = ["--- a/f.txt", "+++ b/f.txt", "@@ -1,4 +1,4 @@", " ", " ", " line 50", "-line 51", "+CHANGED 51", ""].join("\n");
    const r = await apply(real.join("\n") + "\n", diff);
    expect(r.ok).toBe(false);
  });
});
