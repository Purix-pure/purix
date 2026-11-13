// Release 1 surface: the CLI says "not checked" and "could not check" in plain words, and never reads them as a clean pass.
import { describe, it } from "node:test";
import { expect } from "expect";
import { formatCoverageLine, formatStopLines, runVerificationOf } from "./change_summary.js";
import { runSummaryHeading } from "./savings_output.js";

describe("runVerificationOf", () => {
  it("is passed only when nothing was left untested or unchecked", () => {
    expect(runVerificationOf({})).toBe("passed");
    expect(runVerificationOf({ notTested: ["a.ts"] })).toBe("partial");
    expect(runVerificationOf({ notChecked: ["main.go"] })).toBe("partial");
  });
});

describe("coverage line with unchecked files", () => {
  it("says some files were not checked and never says every file was reached", () => {
    const line = formatCoverageLine({ verification: "partial", isolation: "bwrap", changedCount: 2, notTestedCount: 0, notCheckedCount: 1 });
    expect(line).toContain("1 of 2 changed files was not checked");
    expect(line).not.toContain("every changed file was reached");
  });
  it("heading does not claim a complete verification", () => {
    expect(runSummaryHeading("partial")).not.toContain("Complete");
  });
});

describe("stop lines", () => {
  it("an infrastructure stop is not called a failure of the change", () => {
    const text = formatStopLines({ reason: "tsc could not be started.", infrastructure: { kind: "not_installed", actionHint: "Run purix tools install typescript." } }).join("\n");
    expect(text).toContain("Could not check");
    expect(text).toContain("not a failure of your code");
    expect(text).toContain("purix tools install typescript");
    expect(text).not.toContain("Change not applied. tsc");
  });
  it("an unsupported language says not checked", () => {
    const text = formatStopLines({ reason: "Unsupported language, not checked: Go (main.go).", infrastructure: { kind: "unsupported_language" } }).join("\n");
    expect(text).toContain("Not checked: unsupported language");
  });
  it("a code failure keeps the old wording", () => {
    expect(formatStopLines({ reason: "TS2322 bad type" }).join("\n")).toContain("Change not applied. TS2322 bad type");
  });
});
