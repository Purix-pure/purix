import { describe, it } from "node:test";
import { expect } from "expect";
import { TEST_SEARCH_CUT_NOTE, withCutNote, changedFilesNotVouchedFor } from "./discovery_cut.js";

describe("F06-05: a cut-off test search says so", () => {
  it("leaves a reason alone when the search finished", () => {
    expect(withCutNote("no test covers a.ts", false)).toBe("no test covers a.ts");
  });
  it("adds the cut-off sentence to a reason when the search was cut", () => {
    const r = withCutNote("no test covers a.ts", true);
    expect(r.startsWith("no test covers a.ts")).toBe(true);
    expect(r).toContain(TEST_SEARCH_CUT_NOTE);
  });
  it("names every changed file as not vouched for when the search was cut, none when it was not", () => {
    expect(changedFilesNotVouchedFor({ truncated: true }, ["a.ts", "b.ts"])).toEqual(["a.ts", "b.ts"]);
    expect(changedFilesNotVouchedFor({ truncated: false }, ["a.ts"])).toEqual([]);
    expect(changedFilesNotVouchedFor(undefined, ["a.ts"])).toEqual([]);
  });
  it("the note does not use the reserved wording of verify/outcome.ts", () => {
    expect(TEST_SEARCH_CUT_NOTE.toLowerCase()).not.toContain("not tested");
  });
});
