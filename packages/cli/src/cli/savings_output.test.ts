import { describe, test } from "node:test";
import { expect } from "expect";
import { runSummaryHeading } from "./savings_output.js";

describe("run summary heading (C-36, FR-04)", () => {
  test("only a passed verification says Verification Complete", () => {
    expect(runSummaryHeading("passed")).toContain("Verification Complete");
    for (const v of [undefined, "failed", "skipped", "partial"] as const) {
      expect(runSummaryHeading(v)).not.toContain("Verification Complete");
      expect(runSummaryHeading(v)).not.toContain("✅");
    }
  });
  test("failed and skipped say so", () => {
    expect(runSummaryHeading("failed")).toContain("did not pass");
    expect(runSummaryHeading("skipped")).toContain("not run");
  });
  test("partial says something was not tested", () => {
    expect(runSummaryHeading("partial")).toContain("not everything was tested");
  });
});
