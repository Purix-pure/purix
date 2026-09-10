// packages/cli/src/cli/savings_output.test.ts
import { describe, it } from "node:test";
import { expect } from "expect";
import { snapshotSavings } from "./savings_output";

describe("CLI Savings Output", () => {
  it("snapshots savings summary", () => {
    const snap = snapshotSavings();
    expect(snap).toBeTruthy();
    expect(typeof snap.totalSavingsUsd).toBe("number");
  });
});
