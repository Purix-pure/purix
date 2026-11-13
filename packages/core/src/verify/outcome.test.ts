// The result vocabulary (docs/ADR-DRAFT-result-vocabulary.md): today's values map onto it, and a check
// that was skipped or errored never renders as a pass.
import { describe, it } from "node:test";
import { expect } from "expect";
import { testRunOutcome, verificationOutcome, notTestedMessage, listFiles, storedStatusLabel } from "./outcome.js";

describe("notTestedMessage with a cut-off test search", () => {
  it("says the search stopped, and no longer claims no test is related", () => {
    const m = notTestedMessage(["src/a.ts"], { searchCut: true })!;
    expect(m).toMatch(/^Not tested: /);
    expect(m).toContain("file limit");
    expect(m).not.toContain("no test is related");
  });
  it("is the unchanged sentence without the option", () => {
    expect(notTestedMessage(["src/a.ts"], { searchCut: false })).toBe(notTestedMessage(["src/a.ts"]));
  });
});

describe("testRunOutcome", () => {
  it("maps every runner status, and no_tests is a skip, never a pass", () => {
    expect(testRunOutcome("pass")).toBe("pass");
    expect(testRunOutcome("fail")).toBe("fail");
    expect(testRunOutcome("no_tests")).toBe("skipped");
    expect(testRunOutcome("not_installed")).toBe("error");
  });
});

describe("verificationOutcome", () => {
  it("fail and not_installed are never pass", () => {
    expect(verificationOutcome({ status: "fail" })).toBe("fail");
    expect(verificationOutcome({ status: "not_installed" })).toBe("error");
  });
  it("a pass that left files untested is skipped, not pass", () => {
    expect(verificationOutcome({ status: "pass", notTested: ["a.ts"] })).toBe("skipped");
  });
  it("a pass with nothing untested (absent or empty list) is pass", () => {
    expect(verificationOutcome({ status: "pass" })).toBe("pass");
    expect(verificationOutcome({ status: "pass", notTested: [] })).toBe("pass");
  });
});

describe("not-tested wording", () => {
  it("says 'not tested', never 'clean' or 'verified'", () => {
    const m = notTestedMessage(["src/a.ts"])!;
    expect(m).toMatch(/^Not tested: no test is related to src\/a\.ts/);
    expect(m).not.toMatch(/clean|verified/i);
  });
  it("returns nothing when everything was tested", () => {
    expect(notTestedMessage(undefined)).toBeUndefined();
    expect(notTestedMessage([])).toBeUndefined();
  });
  it("de-duplicates and caps a long list so it cannot bury the line", () => {
    expect(listFiles(["a", "a", "b"])).toBe("a, b");
    expect(listFiles(["a", "b", "c", "d", "e", "f", "g"])).toBe("a, b, c, d, e and 2 more");
  });
  it("shows a pending manifest status as 'pending, not tested' (create compiles, adopt runs nothing)", () => {
    expect(storedStatusLabel("pending")).toBe("pending, not tested");
    expect(storedStatusLabel("pass")).toBe("pass");
    expect(storedStatusLabel("fail")).toBe("fail");
  });
});
