import { test } from "node:test";
import assert from "node:assert/strict";
import { add } from "./passing_fixture.js";

test("add sums two numbers", () => {
  assert.strictEqual(add(2, 3), 5);
});
