// packages/cli/src/cli/commands/lifecycle.test.ts
import { describe, it } from "node:test";
import { expect } from "expect";
import { registerLifecycleCommands } from "./lifecycle";

describe("CLI Lifecycle Command", () => {
  it("exists as a function", () => {
    expect(typeof registerLifecycleCommands).toBe("function");
  });
});
