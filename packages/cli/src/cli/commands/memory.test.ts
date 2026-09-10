// packages/cli/src/cli/commands/memory.test.ts
import { describe, it } from "node:test";
import { expect } from "expect";
import { registerMemoryCommands } from "./memory";

describe("CLI Memory Command", () => {
  it("exists as a function", () => {
    expect(typeof registerMemoryCommands).toBe("function");
  });
});
