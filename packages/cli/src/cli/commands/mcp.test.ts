// packages/cli/src/cli/commands/mcp.test.ts
import { describe, it } from "node:test";
import { expect } from "expect";
import { registerMcpCommands } from "./mcp";

describe("CLI MCP Command", () => {
  it("exists as a function", () => {
    expect(typeof registerMcpCommands).toBe("function");
  });
});
