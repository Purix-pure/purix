import { test } from "node:test";
import { expect } from "expect";
import { computeTotal } from "./passing_fixture.js";

test("computeTotal returns the correct total", () => {
  expect(computeTotal([1, 2, 3])).toBe(6);
  expect(computeTotal([])).toBe(0);
});
