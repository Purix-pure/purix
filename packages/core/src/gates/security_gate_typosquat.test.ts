// F03-04 (2026-11-07): the typosquat check flagged well-known real packages that happen to sit within two edits of a name on its
// list (vite next to vitest, chai next to chalk, tsup next to tsx, expect next to express). It must still flag a name that is
// near a popular one and is not itself a known real package.
import { describe, it } from "node:test";
import { expect } from "expect";
import { runSecurityGate } from "./security_gate";
import { isolateCwdForFile } from "../test-support/isolated_cwd.js";

isolateCwdForFile();
const typos = (deps: Record<string, string>) =>
  runSecurityGate([{ path: "package.json", content: JSON.stringify({ devDependencies: deps }) }]).findings.filter((f) => f.category === "Typosquatting Risk");

describe("typosquat check: known real neighbours", () => {
  for (const real of ["vite", "chai", "tsup", "expect", "mocha", "jsdom"]) {
    it(`does not flag ${real}`, () => {
      expect(typos({ [real]: "^1.0.0" })).toEqual([]);
    });
  }
  for (const fake of ["lodas", "expresss", "reakt", "vitesx"]) {
    it(`still flags ${fake}`, () => {
      expect(typos({ [fake]: "^1.0.0" }).length).toBeGreaterThan(0);
    });
  }
});
