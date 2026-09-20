import { test } from "node:test";
import { expect } from "expect";
import { computeTotal } from "./passing_fixture.js";

test("computeTotal returns the correct total", () => {
  // Assertion count dropped from 2 to 1, and the [] target disappeared —
  // this is exactly what checkTestIntegrity is built to flag. Note:
  // test_integrity.ts parses this file with ts-morph and never executes
  // it, so `expect`/`computeTotal` don't need to actually resolve.
  expect(computeTotal([1, 2, 3])).toBe(6);
});
