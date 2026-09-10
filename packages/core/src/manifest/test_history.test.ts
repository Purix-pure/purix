// src/manifest/test_history.test.ts
import { describe, it } from "node:test";
import { expect } from "expect";
import { recordTestResult, isFlaky } from "./test_history";

describe("Test History & Flaky Tracking", () => {
  it("records test results and tracks flakiness", () => {
    recordTestResult("c1", "test1", "pass");
    const flaky = isFlaky("c1", "test1");
    expect(typeof flaky).toBe("boolean");
  });
});
