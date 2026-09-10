// packages/cli/src/cli/commands/provider.test.ts
import { describe, it } from "node:test";
import { expect } from "expect";
import { registerProviderCommands } from "./provider";

describe("CLI Provider Command", () => {
  it("exists as a function", () => {
    expect(typeof registerProviderCommands).toBe("function");
  });
});
