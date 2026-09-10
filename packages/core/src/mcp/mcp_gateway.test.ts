// src/mcp/mcp_gateway.test.ts
import { describe, it } from "node:test";
import { expect } from "expect";
import { callServerTool } from "./mcp_gateway";

describe("MCP Gateway", () => {
  it("exists as a function", () => {
    expect(typeof callServerTool).toBe("function");
  });
});
