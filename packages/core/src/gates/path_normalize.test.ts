// A1: normalizeRepoPath.
import { describe, it } from "node:test";
import { expect } from "expect";
import { normalizeRepoPath, repoPathKey } from "./path_normalize.js";

describe("normalizeRepoPath", () => {
  const cases: Array<[string, string]> = [
    ["src\\auth\\login.ts", "src/auth/login.ts"],
    ["./src/a.ts", "src/a.ts"],
    ["src//a///b.ts", "src/a/b.ts"],
    ["src/./a/../b.ts", "src/b.ts"],
    ["src/a/", "src/a"],
    ["../x.ts", "../x.ts"],
    ["a/../../x.ts", "../x.ts"],
    ["/abs/./p/../q", "/abs/q"],
    ["\\\\?\\C:\\repo\\a.ts", "C:/repo/a.ts"],
    [".", "."],
    ["./", "."],
    ["", ""],
  ];
  for (const [input, want] of cases) it(`${JSON.stringify(input)} -> ${JSON.stringify(want)}`, () => expect(normalizeRepoPath(input)).toBe(want));

  it("keeps case unless asked", () => {
    expect(normalizeRepoPath("src/Auth/X.ts")).toBe("src/Auth/X.ts");
    expect(normalizeRepoPath("src/Auth/X.ts", { foldCase: true })).toBe("src/auth/x.ts");
    expect(repoPathKey("SRC\\Auth\\X.ts")).toBe("src/auth/x.ts");
  });
  it("joins two Unicode spellings of the same name", () => {
    expect(normalizeRepoPath("caf\u0065\u0301/a")).toBe(normalizeRepoPath("caf\u00e9/a"));
  });
  it("strips trailing dots and spaces per segment only with windowsNames", () => {
    expect(normalizeRepoPath("src/auth./x.ts")).toBe("src/auth./x.ts");
    expect(normalizeRepoPath("src/auth./x.ts", { windowsNames: true })).toBe("src/auth/x.ts");
    expect(normalizeRepoPath("src/auth /x.ts", { windowsNames: true })).toBe("src/auth/x.ts");
    expect(normalizeRepoPath("a/../b", { windowsNames: true })).toBe("b");
  });
  it("is idempotent", () => {
    for (const [input] of cases) {
      const once = normalizeRepoPath(input, { foldCase: true });
      expect(normalizeRepoPath(once, { foldCase: true })).toBe(once);
    }
  });
});
