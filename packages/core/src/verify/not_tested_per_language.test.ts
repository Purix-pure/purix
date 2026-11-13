// src/verify/not_tested_per_language.test.ts
//
// C3 item 4 (plan v4): the "search for tests was cut off" flag covered a whole run, so a change in two languages where only ONE search was
// cut worded every untested file as cut. The record now also lists WHICH untested files the cut search covered, and the sentence splits.
import { describe, it } from "node:test";
import { expect } from "expect";
import { notTestedMessage } from "./outcome";
import { searchCutDetail, detailSearchCutFiles } from "./discovery_cut";

describe("notTestedMessage with a per-file cut list", () => {
  it("without a cut list, a cut search words every file as cut (as before)", () => {
    expect(notTestedMessage(["a.ts", "b.py"], { searchCut: true })).toMatch(/stopped at its file limit, so no test could be shown to cover a\.ts, b\.py/);
  });
  it("with a cut list that covers only one file, the other file keeps the plain wording", () => {
    const m = notTestedMessage(["a.ts", "b.py"], { searchCut: true, cutFiles: ["b.py"] })!;
    expect(m).toMatch(/no test is related to a\.ts\./);
    expect(m).toMatch(/stopped at its file limit, so no test could be shown to cover b\.py/);
    expect(m).not.toMatch(/related to a\.ts, b\.py/);
    expect(m).not.toMatch(/cover a\.ts/);
  });
  it("a cut list that covers every file is the same as no list", () => {
    expect(notTestedMessage(["a.ts"], { searchCut: true, cutFiles: ["a.ts"] })).toBe(notTestedMessage(["a.ts"], { searchCut: true }));
  });
  it("a cut list is ignored when the search was not cut", () => {
    expect(notTestedMessage(["a.ts"], { cutFiles: ["a.ts"] })).toMatch(/no test is related to a\.ts/);
  });
});

describe("the stored record carries the cut files", () => {
  it("searchCutDetail writes both fields, and reads them back", () => {
    const d = searchCutDetail({ testSearchCut: true, testSearchCutFiles: ["b.py"] });
    expect(d).toEqual({ test_search_cut: true, test_search_cut_files: ["b.py"] });
    expect(detailSearchCutFiles(d)).toEqual(["b.py"]);
  });
  it("no cut, no fields; a record from before this change has no list", () => {
    expect(searchCutDetail({})).toEqual({});
    expect(detailSearchCutFiles({ test_search_cut: true })).toBeUndefined();
  });
});
