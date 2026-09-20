import { test } from "node:test";
import assert from "node:assert/strict";
import { subtract } from "./broken_test_fixture.js";

test("subtract — intentionally wrong expectation", () => {
  // Deliberately wrong: 5 - 3 is 2, not 10. This must fail.
  assert.strictEqual(subtract(5, 3), 10);
});
