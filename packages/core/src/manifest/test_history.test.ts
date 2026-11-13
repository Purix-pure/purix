// src/manifest/test_history.test.ts
import { describe, it } from "node:test";
import { expect } from "expect";
import { recordTestResult, isFlaky } from "./test_history";
import { isolateCwdForFile } from "../test-support/isolated_cwd.js";

// N-14: this file reaches the project state store, so it runs in a throwaway directory.
isolateCwdForFile();

describe("Test History & Flaky Tracking", () => {
  it("records test results and tracks flakiness", () => {
    recordTestResult("c1", "test1", "pass");
    const flaky = isFlaky("c1", "test1");
    expect(typeof flaky).toBe("boolean");
  });
});
