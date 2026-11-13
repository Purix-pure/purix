// src/manifest/not_tested_cut.test.ts
//
// C3 item 1 (plan v4): `purix status` said only "not tested: N file(s)" even when the search for tests stopped at its file limit
// (F06-05), so a row could read as "no test exists" when nobody had looked everywhere. The badge now says when the search was cut.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb } from "./store";
import { recordEvent } from "./events";
import { latestNotTestedByComponent, latestSearchCutByComponent, latestSearchCutFilesByComponent } from "./not_tested";
import { notTestedBadge } from "../verify/outcome";
import { safeRmSync } from "../platform/fs_retry";

let cwd: string;
let dir: string;
beforeEach(() => { cwd = process.cwd(); dir = mkdtempSync(join(tmpdir(), "purix-nt-cut-")); process.chdir(dir); });
afterEach(() => { closeDb(); process.chdir(cwd); safeRmSync(dir); });

const pass = (component: string, detail: Record<string, unknown>) => recordEvent("verification_pass", { component_id: component, operation: "modify", detail });

describe("status: the not-tested badge names a cut-off search", () => {
  it("badge words", () => {
    expect(notTestedBadge(["a.ts", "b.ts"])).toBe("not tested: 2 file(s)");
    expect(notTestedBadge(["a.ts", "b.ts"], { searchCut: true })).toBe("not tested: 2 file(s), search for tests stopped at its file limit");
  });

  it("badge says how many files the cut covered when it was only some", () => {
    expect(notTestedBadge(["a.ts", "b.ts", "c.ts"], { searchCut: true, cutFiles: ["b.ts"] })).toBe("not tested: 3 file(s), search for tests stopped at its file limit for 1 of them");
    expect(notTestedBadge(["a.ts", "b.ts"], { searchCut: true, cutFiles: ["a.ts", "b.ts"] })).toBe("not tested: 2 file(s), search for tests stopped at its file limit");
    expect(notTestedBadge(["a.ts", "b.ts"], { searchCut: true, cutFiles: ["z.ts"] })).toBe("not tested: 2 file(s)");
  });

  it("the per-component record carries the cut file list, or undefined for an older record", () => {
    pass("a", { not_tested: ["a.ts", "x.ts"], test_search_cut: true, test_search_cut_files: ["a.ts"] });
    pass("b", { not_tested: ["b.ts"], test_search_cut: true });
    const m = latestSearchCutFilesByComponent();
    expect(m.get("a")).toEqual(["a.ts"]);
    expect(m.has("b")).toBe(true);
    expect(m.get("b")).toBeUndefined();
  });

  it("only the LATEST pass counts, per component", () => {
    pass("a", { not_tested: ["a.ts"], test_search_cut: true });
    pass("b", { not_tested: ["b.ts"] });
    pass("c", { not_tested: ["c.ts"], test_search_cut: true });
    pass("c", { not_tested: ["c.ts"] }); // a later, complete search replaces the cut one
    pass("d", { not_tested: ["d.ts"], test_search_cut: true });
    pass("d", {}); // a later pass with nothing untested clears it
    expect([...latestSearchCutByComponent()]).toEqual(["a"]);
    expect([...latestNotTestedByComponent().keys()].sort()).toEqual(["a", "b", "c"]);
  });
});
