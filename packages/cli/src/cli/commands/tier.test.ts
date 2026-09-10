// packages/cli/src/cli/commands/tier.test.ts
import { describe, it } from "node:test";
import { expect } from "expect";
import { registerTierCommands } from "./tier";

describe("CLI Tier Command", () => {
  it("exists as a function", () => {
    expect(typeof registerTierCommands).toBe("function");
  });
});
