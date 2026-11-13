// Completion plan 0.4, anchor rules. A diff that arrives from an agent or a chat window is often damaged in small ways. What must hold:
// a blank context line that lost its leading space is still read as context; a diff cut off in the middle of a hunk is refused and
// never applied as a shorter hunk; a header that miscounts in the middle of a diff is recounted from the real lines; a complete,
// well-formed diff is untouched; and a hunk may be moved away from its stated line only when its old side is a real anchor
// (at least 3 non-blank lines), never a lone line or a run of blank lines.
//
// Limit (stated in docs/claims.json): a LAST hunk whose header over-counts cannot be told from a cut-off and is refused. How many
// real diffs that affects is unmeasured, because the 1,018-file replay corpus was not rebuilt.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingestDiff } from "./ingest";
import { safeRmSync } from "../platform/fs_retry.js";

describe("ingestDiff anchor rules", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "purix-anchor-"));
  });
  afterEach(() => safeRmSync(dir));

  const apply = async (content: string, diff: string) => {
    writeFileSync(join(dir, "f.txt"), content);
    return ingestDiff(diff, null, dir);
  };
  const nl = (a: string[]) => a.join("\n") + "\n";

  it("a blank context line whose leading space was stripped is read as a blank context line", async () => {
    const file = nl(["a", "b", "", "c", "d"]);
    // the blank line between b and c lost its leading space; the header still expects 5 old and 5 new lines
    const diff = nl(["--- a/f.txt", "+++ b/f.txt", "@@ -1,5 +1,5 @@", " a", " b", "", " c", "-d", "+D"]);
    const r = await apply(file, diff);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.files[0]!.new_content).toBe(nl(["a", "b", "", "c", "D"]));
  });

  it("a diff cut off in the middle of a hunk is refused", async () => {
    const file = nl(["a", "b", "c", "d", "e", "f"]);
    // the header promises 6 old lines; the text stops after 4
    const diff = nl(["--- a/f.txt", "+++ b/f.txt", "@@ -1,6 +1,6 @@", " a", " b", " c", "-d"]);
    const r = await apply(file, diff);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("cut off");
  });

  it("a header that miscounts in the MIDDLE of a diff is recounted", async () => {
    const file = nl(Array.from({ length: 30 }, (_, i) => `row ${i + 1}`));
    const diff = nl([
      "--- a/f.txt", "+++ b/f.txt",
      "@@ -2,9 +2,9 @@", // says 9, there are 3 lines: a miscount, and not the last hunk
      " row 2", "-row 3", "+ROW 3", " row 4",
      "@@ -20,3 +20,3 @@", " row 20", "-row 21", "+ROW 21", " row 22",
    ]);
    const r = await apply(file, diff);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const out = r.files[0]!.new_content.split("\n");
      expect(out[2]).toBe("ROW 3");
      expect(out[20]).toBe("ROW 21");
    }
  });

  it("a complete, well-formed diff is unaffected", async () => {
    const file = nl(["one", "two", "three", "four"]);
    const diff = nl(["--- a/f.txt", "+++ b/f.txt", "@@ -1,4 +1,4 @@", " one", "-two", "+TWO", " three", " four"]);
    const r = await apply(file, diff);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.files[0]!.new_content).toBe(nl(["one", "TWO", "three", "four"]));
  });

  it("a one-line anchor in the middle of a file is not moved", async () => {
    const real = nl([...Array.from({ length: 5 }, (_, i) => `top ${i}`), ...Array.from({ length: 40 }, (_, i) => `row ${i + 1}`)]);
    // one old-side line, stated 5 lines too high
    const diff = nl(["--- a/f.txt", "+++ b/f.txt", "@@ -20,1 +20,1 @@", "-row 20", "+ROW 20"]);
    const r = await apply(real, diff);
    expect(r.ok).toBe(false);
  });

  it("a hunk whose old side is only blank lines is never moved", async () => {
    const real = nl(["a", "", "", "", "b", "c", "d", "e"]);
    const diff = nl(["--- a/f.txt", "+++ b/f.txt", "@@ -20,3 +20,4 @@", " ", " ", " ", "+new"]);
    const r = await apply(real, diff);
    expect(r.ok).toBe(false);
  });

  it("a three-line anchor in the middle of a file is moved", async () => {
    const real = nl([...Array.from({ length: 5 }, (_, i) => `top ${i}`), ...Array.from({ length: 40 }, (_, i) => `row ${i + 1}`)]);
    const diff = nl(["--- a/f.txt", "+++ b/f.txt", "@@ -19,3 +19,3 @@", " row 19", "-row 20", "+ROW 20", " row 21"]);
    // old side = row 19, row 20, row 21 (3 non-blank lines): unique, so it moves down by 5
    const r = await apply(real, diff);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.files[0]!.new_content).toContain("ROW 20");
  });
});
