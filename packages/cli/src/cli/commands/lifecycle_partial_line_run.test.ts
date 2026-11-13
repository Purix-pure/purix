// R1-f (plan v6, C3 item 3): anchors written by repair or escalation during a run are named after the run, once, and a path the compile-time
// note already named is not named again. The harness has no fake-model run that makes repair rewrite partway through a line, so this tests the
// printing step on its own; core's heal and escalate tests cover that the paths reach it.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { printRunPartialLine } from "./lifecycle.js";

describe("printRunPartialLine", () => {
  let lines: string[];
  let original: typeof console.log;
  beforeEach(() => {
    lines = [];
    original = console.log;
    console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  });
  afterEach(() => { console.log = original; });

  it("prints nothing when no path was edited inside a line", () => {
    printRunPartialLine(undefined);
    printRunPartialLine([]);
    expect(lines).toEqual([]);
  });
  it("names the files repair or escalation edited inside a line", () => {
    printRunPartialLine(["src/a.ts", "src/b.ts"]);
    expect(lines.join("\n")).toContain("Edited inside a line in src/a.ts, src/b.ts");
  });
  it("does not name a path the compile-time note already named", () => {
    printRunPartialLine(["src/a.ts", "src/b.ts"], ["src/a.ts"]);
    const out = lines.join("\n");
    expect(out).toContain("src/b.ts");
    expect(out).not.toContain("src/a.ts");
  });
  it("prints nothing when every path was already named", () => {
    printRunPartialLine(["src/a.ts"], ["src/a.ts"]);
    expect(lines).toEqual([]);
  });
});
