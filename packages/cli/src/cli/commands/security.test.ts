// packages/cli/src/cli/commands/security.test.ts
import { describe, it } from "node:test";
import { expect } from "expect";
import { registerSecurityCommands } from "./security";

describe("CLI Security Command", () => {
  it("exists as a function", () => {
    expect(typeof registerSecurityCommands).toBe("function");
  });
});
