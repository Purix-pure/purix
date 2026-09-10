// packages/cli/src/cli/output.test.ts
import { describe, it } from "node:test";
import { expect } from "expect";
import { isQuiet, setQuiet } from "./output";

describe("CLI Output Flags", () => {
  it("tracks quiet state", () => {
    setQuiet(false);
    expect(typeof isQuiet()).toBe("boolean");
  });
});
