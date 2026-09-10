// packages/cli/src/cli/commands/tools.test.ts
import { describe, it } from "node:test";
import { expect } from "expect";
import { registerToolsCommands } from "./tools";

describe("CLI Tools Command", () => {
  it("exists as a function", () => {
    expect(typeof registerToolsCommands).toBe("function");
  });
});
