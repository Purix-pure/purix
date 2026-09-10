// packages/cli/src/cli/commands/auth.test.ts
import { describe, it } from "node:test";
import { expect } from "expect";
import { registerAuthCommands } from "./auth";

describe("CLI Auth Command", () => {
  it("exists as a function", () => {
    expect(typeof registerAuthCommands).toBe("function");
  });
});
