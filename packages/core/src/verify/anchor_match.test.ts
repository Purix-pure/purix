// AI-06: the anchor cascade. Exact behaviour is frozen against the old implementation; the looser stages are new.
import { describe, it } from "node:test";
import { expect } from "expect";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { matchAnchor, nearestRegion, dominantEol, indentMatters } from "./anchor_match.js";
import { compilePatch } from "./compile.js";
import type { ChangeVerdict } from "../llm/classify.js";

/** The matcher as it was before AI-06, kept here as the oracle for "an exact match behaves byte for byte as today". */
function oldReplace(content: string, oldText: string, newText: string): { ok: true; content: string } | { ok: false; ambiguous: boolean } {
  const n = oldText.length === 0 ? 0 : content.split(oldText).length - 1;
  if (n === 0) return { ok: false, ambiguous: false };
  if (n > 1) return { ok: false, ambiguous: true };
  return { ok: true, content: content.replace(oldText, () => newText) };
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

describe("matchAnchor: exact stage is unchanged", () => {
  it("on random slices of real files, agrees with the old implementation (same content, or same refusal)", () => {
    const files = ["./compile.ts", "../llm/classify.ts", "../llm/prompts/build.ts"].map((f) => readFileSync(fileURLToPath(new URL(f, import.meta.url)), "utf-8"));
    const rand = rng(33);
    let applied = 0, refused = 0;
    for (let n = 0; n < 600; n++) {
      const src = files[n % files.length]!;
      const a = Math.floor(rand() * src.length);
      const len = 1 + Math.floor(rand() * (n % 7 === 0 ? 4 : 160));
      const slice = src.slice(a, a + len);
      const repl = n % 5 === 0 ? "$& $1 $$" : `<<${n}>>`;
      const old = oldReplace(src, slice, repl);
      const now = matchAnchor(src, slice, repl, "x.ts");
      if (old.ok) {
        applied++;
        expect(now.ok).toBe(true);
        if (now.ok) { expect(now.content).toBe(old.content); expect(now.stage).toBe("exact"); }
      } else if (old.ambiguous) {
        refused++;
        expect(now.ok).toBe(false);
        if (!now.ok) expect(now.ambiguous).toBe(true);
      }
    }
    expect(applied).toBeGreaterThan(100);
    expect(refused).toBeGreaterThan(20);
  });

  it("never interprets $&, $$ or $1 in the replacement", () => {
    const r = matchAnchor("price = 5;\n", "5", "$& and $$ and $1", "a.ts");
    expect(r.ok && r.content).toBe("price = $& and $$ and $1;\n");
  });
});

describe("matchAnchor: looser stages", () => {
  const lf = "function f() {\n  const a = 1;\n  return a;\n}\n";
  const crlf = lf.replace(/\n/g, "\r\n");

  it("LF anchor against a CRLF file applies, and the replacement comes out CRLF (no mixed endings)", () => {
    const r = matchAnchor(crlf, "  const a = 1;\n  return a;", "  const a = 2;\n  const b = 3;\n  return a + b;", "a.ts");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.stage).toBe("eol");
      expect(r.content).toBe("function f() {\r\n  const a = 2;\r\n  const b = 3;\r\n  return a + b;\r\n}\r\n");
      expect(/(?<!\r)\n/.test(r.content)).toBe(false);
    }
  });

  it("CRLF anchor against an LF file applies and stays LF", () => {
    const r = matchAnchor(lf, "  const a = 1;\r\n  return a;", "  return 1;", "a.ts");
    expect(r.ok && r.content).toBe("function f() {\n  return 1;\n}\n");
  });

  it("an anchor that ends with a line break keeps the file's line ending intact", () => {
    const r = matchAnchor(crlf, "  const a = 1;\n", "  const a = 9;\n", "a.ts");
    expect(r.ok && r.content).toBe("function f() {\r\n  const a = 9;\r\n  return a;\r\n}\r\n");
  });

  it("trailing whitespace in the file that the anchor lacks (and the reverse) still applies", () => {
    const file = "alpha  \nbeta\t\ngamma\n";
    const r = matchAnchor(file, "alpha\nbeta", "ALPHA\nBETA", "a.ts");
    expect(r.ok && r.stage).toBe("trailing_space");
    expect(r.ok && r.content).toBe("ALPHA\nBETA\ngamma\n");
    const r2 = matchAnchor("alpha\nbeta\n", "alpha   \nbeta  ", "x", "a.ts");
    expect(r2.ok && r2.stage).toBe("trailing_space");
  });

  it("tabs in the file, spaces in the anchor: applies, and the replacement takes the file's indentation", () => {
    const file = "if (x) {\n\tdoA();\n\tdoB();\n}\n";
    const r = matchAnchor(file, "    doA();\n    doB();", "    doA();\n    doC();\n    doB();", "a.ts");
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.stage).toBe("indent"); expect(r.content).toBe("if (x) {\n\tdoA();\n\tdoC();\n\tdoB();\n}\n"); }
  });

  it("an anchor indented less than the file is re-indented by the difference", () => {
    const file = "class A {\n    run() {\n        go();\n    }\n}\n";
    const r = matchAnchor(file, "run() {\n    go();\n}", "run() {\n    go();\n    stop();\n}", "a.ts");
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.stage).toBe("indent"); expect(r.content).toBe("class A {\n    run() {\n        go();\n        stop();\n    }\n}\n"); }
  });

  it("a one-line anchor that is a substring of the line is an exact match, as it always was", () => {
    const r = matchAnchor("a {\n        go();\n}\n", "go();", "go();\nstop();", "a.ts");
    expect(r.ok && r.stage).toBe("exact");
  });

  it("indentation is never ignored for Python, YAML or Makefiles", () => {
    const body = "def f():\n    if x:\n        go()\n        stop()\n";
    const tabbed = "if x:\n\tgo()\n\tstop()"; // a tab-indented anchor is not a substring, so only the indent stage could match it
    for (const path of ["a.py", "ci.yml", "ci.yaml", "Makefile", "rules.mk"]) {
      expect(indentMatters(path)).toBe(true);
      expect(matchAnchor(body, tabbed, "x", path).ok).toBe(false);
    }
    expect(matchAnchor(body, tabbed, "x", "a.ts").ok).toBe(true);
    expect(indentMatters("a.ts")).toBe(false);
  });

  it("two matches in a looser stage are refused, with the first line numbers", () => {
    const file = "  a();\n  b();\n\n  a();\n  b();\n\n  a();\n  b();\n\n  a();\n  b();\n";
    const r = matchAnchor(file, "a();\nb();", "x", "a.ts");
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.ambiguous).toBe(true); expect(r.reason).toMatch(/4 times.*line 1, 4, 7/); }
  });

  it("an exact-stage ambiguity is still refused and lists lines", () => {
    const r = matchAnchor("x\nfoo\ny\nfoo\n", "foo", "bar", "a.ts");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/found 2 times.*line 2, 4.*ambiguous, refusing to guess/);
  });

  it("an anchor of only blank lines identifies nothing", () => {
    expect(matchAnchor("a\n\n\nb\n", "\n\n", "x", "a.ts").ok).toBe(true); // exact stage still applies, as today
    expect(matchAnchor("a\n \n \nb\n", " \n\n", "x", "a.ts").ok).toBe(false); // looser stages refuse
  });
});

describe("nearest region", () => {
  const file = ["line one", "const limit = 10;", "const retries = 3;", "return limit * retries;", "// end"].join("\n");

  it("a miss reports the closest window with line numbers and one line of margin", () => {
    const r = matchAnchor(file, "const limit = 20;\nconst retries = 3;\nreturn limit * retries;", "x", "a.ts");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason.startsWith("anchor text not found in file")).toBe(true);
      expect(r.reason).toContain("lines 2-4 (2 of 3 anchor line(s) match after trimming)");
      expect(r.reason).toContain("   1| line one");
      expect(r.reason).toContain("   2| const limit = 10;");
      expect(r.reason).toContain("   5| // end");
    }
  });

  it("nothing similar says so instead of printing a random region", () => {
    const r = matchAnchor(file, "completely different text", "x", "a.ts");
    expect(!r.ok && r.reason).toBe("anchor text not found in file (no similar region found)");
    expect(nearestRegion("", "abc")).toBeNull();
  });

  it("long regions are cut and long lines truncated", () => {
    const big = Array.from({ length: 60 }, (_, i) => `row ${i} ` + "x".repeat(400)).join("\n");
    const anchor = Array.from({ length: 40 }, (_, i) => `row ${i} ` + "x".repeat(400)).join("\n") + "\nCHANGED";
    const r = nearestRegion(big, anchor)!;
    expect(r.split("\n").length).toBeLessThanOrEqual(15);
    expect(r).toContain("…");
    expect(r).toContain("more line(s)");
  });
});

describe("line ending helpers", () => {
  it("dominantEol follows the majority and defaults to LF", () => {
    expect(dominantEol("a\r\nb\r\nc\n")).toBe("\r\n");
    expect(dominantEol("a\nb\r\nc\n")).toBe("\n");
    expect(dominantEol("no breaks")).toBe("\n");
  });
});

describe("compilePatch with the cascade", () => {
  const verdict = (old_text: string): ChangeVerdict =>
    ({ operation: "update_prompt_text", confidence: "high", reasoning: "r", is_new_capability: false, edits: [{ kind: "prompt_text", path: "p.ts", old_text, new_text: "NEW" }] } as unknown as ChangeVerdict);

  it("reports which stage rescued the anchor, and nothing when every anchor was exact", () => {
    const rescued = compilePatch(verdict("a\nb"), [{ path: "p.ts", content: "a\r\nb\r\n" }]);
    expect(rescued.ok && rescued.anchorRescues).toEqual([{ path: "p.ts", stage: "eol" }]);
    const plain = compilePatch(verdict("a"), [{ path: "p.ts", content: "a\n" }]);
    expect(plain.ok && plain.anchorRescues).toBeUndefined();
  });

  it("the unwired-operation message no longer points at a document section", () => {
    const r = compilePatch({ ...verdict("a"), operation: "rename_symbol" } as unknown as ChangeVerdict, [{ path: "p.ts", content: "a" }]);
    expect(!r.ok && r.reason).toBe('operation "rename_symbol" cannot be applied automatically yet, so nothing was changed');
  });

  it("a miss in compilePatch carries the nearest region", () => {
    const r = compilePatch(verdict("alpha\nbeta"), [{ path: "p.ts", content: "alpha\ngamma\n" }]);
    expect(!r.ok && r.reason).toContain("Nearest region");
  });
});

// A3 remainder (research 04, section 4 gaps): a blank line inside the anchor that the file does not have (or the reverse) is
// rescued; a match that starts or ends in the middle of a line is flagged so a leftover tail is visible. Never fuzzy: still
// unique-or-refuse.
describe("matchAnchor: blank-line rescue and partial-line flag", () => {
  it("rescues an anchor with an extra blank line the file does not have", () => {
    const r = matchAnchor("a();\nb();\nc();\n", "a();\n\nb();\n", "a();\nx();\nb();\n", "f.ts");
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.stage).toBe("blank_lines"); expect(r.content).toBe("a();\nx();\nb();\nc();\n"); }
  });
  it("rescues an anchor that lacks a blank line the file has", () => {
    const r = matchAnchor("a();\n\nb();\nc();\n", "a();\nb();\n", "a();\nb2();\n", "f.ts");
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.stage).toBe("blank_lines"); expect(r.content).toBe("a();\nb2();\nc();\n"); }
  });
  it("still refuses when the blank-line reading matches twice", () => {
    const r = matchAnchor("a();\nb();\nq();\na();\n\nb();\n", "a();\n\n\nb();\n", "z();\n", "f.ts");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.ambiguous).toBe(true);
  });
  it("does not ignore indentation (Python depth stays meaningful)", () => {
    const r = matchAnchor("if x:\n    a()\n\n    b()\n", "if x:\n  a()\n  b()\n", "pass\n", "f.py");
    expect(r.ok).toBe(false);
  });
  it("flags an exact match that ends in the middle of a line", () => {
    const r = matchAnchor("const x = foo(a, b);\n", "const x = foo(", "const x = bar(", "f.ts");
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.stage).toBe("exact"); expect(r.partialLine).toBe(true); expect(r.content).toBe("const x = bar(a, b);\n"); }
  });
  it("does not flag a statement anchored without its indentation (only whitespace of the line stays)", () => {
    const r = matchAnchor("function f() {\n  return 1;\n}\n", "return 1;", "return 2;", "f.ts");
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.content).toBe("function f() {\n  return 2;\n}\n"); expect(r.partialLine).toBeUndefined(); }
  });
  it("does not flag trailing whitespace after the anchor", () => {
    const r = matchAnchor("a();  \nb();\n", "a();", "c();", "f.ts");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.partialLine).toBeUndefined();
  });
  it("still flags a start inside a line when code precedes the anchor", () => {
    const r = matchAnchor("const x = foo(a);\n", "foo(a);", "bar(a);", "f.ts");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.partialLine).toBe(true);
  });
  it("does not flag a match that covers whole lines", () => {
    const r = matchAnchor("const x = foo(a, b);\nnext();\n", "const x = foo(a, b);\n", "const x = bar(a, b);\n", "f.ts");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.partialLine).toBeUndefined();
  });
});

// F04-04, the tail itself: a truncated anchor leaves the rest of its line, and the replacement (written for the whole line) usually ends
// with the same punctuation, so the join doubles it. Replayed on 2,914 truncated-anchor trials over real TypeScript: 34% broke the
// parse, 62% were a doubled `;` or a tail inside a comment, 4% parsed clean but were wrong (`,,` in an array). A doubled `,` or `;` at the
// join is never what an edit means, so that one case is refused; every other partial-line match stays a note (a legitimate edit inside a
// line looks the same as a truncated anchor).
describe("matchAnchor: a replacement that doubles the punctuation after the anchor is refused", () => {
  it("refuses when the replacement ends with the ; that follows the anchor", () => {
    const r = matchAnchor("foo(a);\nnext();\n", "foo(a)", "foo2(a);", "f.ts");
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.ambiguous).toBe(false); expect(r.reason).toContain("already ends with"); expect(r.reason).toContain("whole line"); }
  });
  it("refuses when the replacement ends with the , that follows the anchor", () => {
    const r = matchAnchor("const a = [\n  \"x\",\n  \"y\",\n];\n", "  \"x\"", "  \"xx\",", "f.ts");
    expect(r.ok).toBe(false);
  });
  it("still applies a replacement that does not end with that punctuation", () => {
    const r = matchAnchor("foo(a);\n", "foo(a)", "foo2(a)", "f.ts");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.content).toBe("foo2(a);\n");
  });
  it("still applies a wrapping edit that relies on the closing bracket after the anchor", () => {
    const r = matchAnchor("f(a);\n", "f(a", "f(g(a)", "f.ts");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.content).toBe("f(g(a));\n");
  });
  it("does not refuse when the anchor itself already ends with that punctuation", () => {
    const r = matchAnchor("a;; b\n", "a;", "c;", "f.ts");
    expect(r.ok).toBe(true);
  });
});
