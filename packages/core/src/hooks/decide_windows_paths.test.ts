// A file inside a protected folder must match on every platform. The comparison keys use "/" (gates/path_normalize.ts);
// on Windows the old code appended "\" and never matched, so a write tool could create files in .purix/ (live OpenCode run, 2026-11-03).
import { describe, it } from "node:test";
import { expect } from "expect";
import { normalizeRepoPath } from "../gates/path_normalize.js";
import { isKeyUnder } from "./decide.js";

describe("isKeyUnder with Windows-style paths", () => {
  const k = (s: string) => normalizeRepoPath(s, { foldCase: true });
  it("a file inside the state folder is under it", () => {
    expect(isKeyUnder(k("E:\\test\\real-opencode\\.purix\\hook-canary.txt"), k("E:\\test\\real-opencode\\.purix"))).toBe(true);
  });
  it("the folder itself and a deeper file are under it", () => {
    expect(isKeyUnder(k("E:\\p\\.purix"), k("E:\\p\\.purix"))).toBe(true);
    expect(isKeyUnder(k("E:\\p\\.purix\\a\\b.db"), k("E:\\p\\.purix"))).toBe(true);
  });
  it("a sibling that only shares the prefix is not under it", () => {
    expect(isKeyUnder(k("E:\\p\\.purix-notes\\a.txt"), k("E:\\p\\.purix"))).toBe(false);
    expect(isKeyUnder(k("E:\\p\\src\\a.ts"), k("E:\\p\\.purix"))).toBe(false);
  });
});
