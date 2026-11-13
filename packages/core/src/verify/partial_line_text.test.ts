// F04-04: an exact anchor that starts or ends in the middle of a line leaves the rest of that line in place (research 04, finding 4:
// 145 of 145 `drop_last_char` trials applied and left the tail). The flag existed but only went to an event row. This is the one sentence
// every front door prints for it, so the tail is visible to the person who approves the change.
import { describe, it } from "node:test";
import { expect } from "expect";
import { partialLineMessage } from "./surface_text.js";
import { compilePatch } from "./compile.js";
import type { ChangeVerdict } from "../llm/classify.js";

describe("partialLineMessage", () => {
  it("says nothing when no edit was partial", () => {
    expect(partialLineMessage(undefined)).toBeUndefined();
    expect(partialLineMessage([])).toBeUndefined();
  });
  it("names the file and says the rest of the line was kept", () => {
    const m = partialLineMessage(["src/a.ts"]) ?? "";
    expect(m).toContain("src/a.ts");
    expect(m).toContain("rest of that line");
    expect(m).not.toMatch(/passed|clean|verified/i);
  });
  it("lists at most three files and counts the others", () => {
    const m = partialLineMessage(["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]) ?? "";
    expect(m).toContain("a.ts, b.ts, c.ts");
    expect(m).not.toContain("d.ts");
    expect(m).toContain("2 more");
  });
});

describe("compile: a truncated anchor reaches the result as partialLinePaths", () => {
  const verdict = (old_text: string, new_text: string): ChangeVerdict =>
    ({ operation: "update_prompt_text", confidence: "high", reasoning: "r", is_new_capability: false, edits: [{ kind: "prompt_text", path: "f.ts", old_text, new_text }] } as unknown as ChangeVerdict);

  it("is reported for a mid-line match", () => {
    const r = compilePatch(verdict("const x = foo(", "const x = bar("), [{ path: "f.ts", content: "const x = foo(a, b);\n" }]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.partialLinePaths).toEqual(["f.ts"]);
  });
  it("is absent for a whole-line match", () => {
    const r = compilePatch(verdict("const x = foo(a, b);\n", "const x = bar(a, b);\n"), [{ path: "f.ts", content: "const x = foo(a, b);\n" }]);
    expect(r.ok && r.partialLinePaths).toBeUndefined();
  });
});
