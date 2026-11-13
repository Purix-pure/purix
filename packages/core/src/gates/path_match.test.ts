// A1: the shared path matcher.
import { describe, it } from "node:test";
import { expect } from "expect";
import { matchPath, matchAnyPath, MAX_PATH_LENGTH, MAX_PATTERN_LENGTH } from "./path_match.js";
import { checkDeterministicOverrideFloor } from "./trustgate.js";

const FLOOR = ["**/auth/**", "**/migrations/**", "**/*.env*", "src/security/**"];

describe("matchPath language", () => {
  it("** crosses folders, including zero", () => {
    expect(matchPath("auth/x.ts", "**/auth/**")).toBe(true);
    expect(matchPath("a/b/auth/c/d.ts", "**/auth/**")).toBe(true);
    expect(matchPath("x.env", "**/*.env*")).toBe(true);
  });
  it("* stays inside one folder", () => {
    expect(matchPath("src/a.ts", "src/*.ts")).toBe(true);
    expect(matchPath("src/sub/a.ts", "src/*.ts")).toBe(false);
  });
  it("? is exactly one non-slash character", () => {
    expect(matchPath("a1.ts", "a?.ts")).toBe(true);
    expect(matchPath("a.ts", "a?.ts")).toBe(false);
    expect(matchPath("a/.ts", "a?.ts")).toBe(false);
  });
  it("regex characters in a pattern are literal", () => {
    expect(matchPath("a+b(1).ts", "a+b(1).ts")).toBe(true);
    expect(matchPath("aab.ts", "a+b.ts")).toBe(false);
  });
  it("keeps the floor's known over-match (documented), so a switch does not change it", () => {
    expect(matchPath("src/notauth/x.ts", "**/auth/**")).toBe(true);
  });
  it("does not match a different folder", () => {
    expect(matchPath("src/other/x.ts", "src/security/**")).toBe(false);
  });
});

describe("matchPath normalisation (the floor probe misses)", () => {
  it("a Windows path hits a rule written with /", () => {
    expect(matchPath("src\\auth\\login.ts", "**/auth/**")).toBe(true);
    expect(matchPath(".\\src\\security\\k.ts", "src/security/**")).toBe(true);
  });
  it("case differences hit by default and are exact when folding is off", () => {
    expect(matchPath("src/Auth/login.ts", "**/auth/**")).toBe(true);
    expect(matchPath("SRC/Security/k.ts", "src/security/**")).toBe(true);
    expect(matchPath("src/Auth/login.ts", "**/auth/**", { foldCase: false })).toBe(false);
  });
  it("a dot segment or a .. detour does not hide a path", () => {
    expect(matchPath("src/x/../security/k.ts", "src/security/**")).toBe(true);
    expect(matchPath("src/./security/k.ts", "src/security/**")).toBe(true);
  });
  it("a pattern written with a backslash or leading ./ behaves like the plain form", () => {
    expect(matchPath("src/security/k.ts", "src\\security\\**")).toBe(true);
    expect(matchPath("src/security/k.ts", "./src/security/**")).toBe(true);
  });
});

describe("parity with the trust floor on already-normal input", () => {
  const paths = [
    "auth/a.ts", "src/auth/a.ts", "src/notauth/a.ts", "src/authx/a.ts", "db/migrations/001.sql", ".env", "config/prod.env", "a.env.local",
    "src/security/k.ts", "src/security", "src/security/deep/er/k.ts", "lib/security/k.ts", "README.md", "src/a.ts", "auth", "migrations/x",
  ];
  for (const p of paths) {
    it(`same answer for ${p}`, () => {
      const old = checkDeterministicOverrideFloor([p], FLOOR).hit;
      expect(matchAnyPath([p], FLOOR, { foldCase: false }).hit).toBe(old);
    });
  }
});

describe("matchAnyPath", () => {
  it("returns the first hit with the path as given and the pattern that matched", () => {
    const r = matchAnyPath(["ok.ts", "src\\Auth\\x.ts"], FLOOR);
    expect(r).toEqual({ hit: true, matchedPath: "src\\Auth\\x.ts", matchedPattern: "**/auth/**" });
  });
  it("no hit", () => {
    expect(matchAnyPath(["a.ts", "b/c.ts"], FLOOR)).toEqual({ hit: false });
  });
});

describe("limits", () => {
  it("refuses an over-long pattern", () => {
    expect(() => matchPath("a", "a".repeat(MAX_PATTERN_LENGTH + 1))).toThrow(RangeError);
  });
  it("an over-length path throws by default and is a hit when the caller asks for the deny-safe answer", () => {
    const long = "a/".repeat(MAX_PATH_LENGTH);
    expect(() => matchPath(long, "src/**")).toThrow(RangeError);
    expect(matchPath(long, "src/**", { overLength: "match" })).toBe(true);
    expect(matchAnyPath([long], FLOOR, { overLength: "match" }).overLength).toBe(true);
  });
  it("a pattern built to make a regex backtrack finishes quickly on a long non-matching path", () => {
    const path = "a".repeat(8000) + "b";
    const t = Date.now();
    expect(matchPath(path, "**/**/**/**/**/**/**/**/a")).toBe(false);
    expect(matchPath(path, "*a*a*a*a*a*a*a*a*c")).toBe(false);
    expect(Date.now() - t).toBeLessThan(2000);
  });
});
