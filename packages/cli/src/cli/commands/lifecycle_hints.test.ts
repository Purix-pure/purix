// Guards user-facing hints in the CLI against pointing at commands that no longer exist.
// accept-drift moved under `migration`; lifecycle.ts kept telling users to run the old top-level form.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("lifecycle.ts user-facing hints", () => {
  it("never tells users to run the removed top-level `purix accept-drift`", () => {
    const src = readFileSync(fileURLToPath(new URL("./lifecycle.ts", import.meta.url)), "utf-8");
    assert.doesNotMatch(src, /purix accept-drift/);
    assert.match(src, /purix migration accept-drift/);
  });
});
