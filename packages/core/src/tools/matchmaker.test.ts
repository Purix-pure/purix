// src/tools/matchmaker.test.ts
import { describe, it } from "node:test";
import { expect } from "expect";
import { suggestTools } from "./matchmaker";

describe("Tool Matchmaker", () => {
  it("suggests tools for a purpose", async () => {
    const suggestions = await suggestTools("database");
    expect(Array.isArray(suggestions)).toBe(true);
  });
});
