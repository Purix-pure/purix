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

describe("suggestTools: malformed registry responses never throw", () => {
  it("returns [] for an HTTP 200 whose body has no objects array", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ choices: [] }), { status: 200 }));
    try {
      expect(await suggestTools("anything")).toEqual([]);
    } finally {
      globalThis.fetch = original;
    }
  });
});