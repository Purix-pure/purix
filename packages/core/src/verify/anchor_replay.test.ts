// packages/core/src/verify/anchor_replay.test.ts
//
// A3-2 (research 04 task 6, probe E7): a text-anchor edit whose new text still contains the old text used to apply a second time
// ("x = 1" -> "x = 1; y = 2" replayed gave "x = 1; y = 2; y = 2"). A cached fix is replayed by the escalation library and a repair
// round can re-issue the same edit, so the matcher now refuses an edit that is already in place. An insertion whose new text
// happens to exist somewhere else in the file is still accepted: only the same spot counts.
import { describe, it } from "node:test";
import { expect } from "expect";
import { matchAnchor } from "./anchor_match.js";

describe("matchAnchor: an edit that is already applied is refused", () => {
  it("x = 1 -> x = 1; y = 2 applies once and is refused the second time", () => {
    const once = matchAnchor("let x = 1;\n", "x = 1", "x = 1; y = 2", "a.js");
    expect(once.ok).toBe(true);
    if (!once.ok) return;
    expect(once.content).toBe("let x = 1; y = 2;\n");
    const twice = matchAnchor(once.content, "x = 1", "x = 1; y = 2", "a.js");
    expect(twice.ok).toBe(false);
    if (!twice.ok) {
      expect(twice.reason).toMatch(/already (applied|in place)/i);
      expect(twice.ambiguous).toBe(false);
    }
  });
  it("an insertion after an anchor is refused when the same line is already there", () => {
    const r = matchAnchor("a();\nb();\n", "a();\n", "a();\nb();\n", "a.js");
    expect(r.ok).toBe(false);
  });
  it("the new text existing somewhere else in the file does not count as applied", () => {
    const r = matchAnchor("a();\nc();\nb();\n", "a();\n", "a();\nb();\n", "a.js");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.content).toBe("a();\nb();\nc();\nb();\n");
  });
  it("an ordinary replacement whose new text does not contain the old is unaffected", () => {
    const r = matchAnchor("limit = 5\n", "limit = 5", "limit = 9", "a.py");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.content).toBe("limit = 9\n");
  });
  it("an anchor that has become ambiguous after a first application is still refused as ambiguous", () => {
    const first = matchAnchor("go\n", "go", "go go", "a.txt");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.content).toBe("go go\n");
    const again = matchAnchor(first.content, "go", "go go", "a.txt");
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.ambiguous).toBe(true);
  });
});
