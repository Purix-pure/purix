// src/verify/idiom.test.ts
import { describe, it } from "node:test";
import { expect } from "expect";
import { checkIdioms } from "./idiom";

describe("Verify Idiom", () => {
  it("exists as a function", () => {
    expect(typeof checkIdioms).toBe("function");
  });
});
