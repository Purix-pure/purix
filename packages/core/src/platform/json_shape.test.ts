import { describe, it } from "node:test";
import { expect } from "expect";
import { asArray, asObject, asText } from "./json_shape.js";

describe("json_shape (H1)", () => {
  it("asObject keeps a plain object and turns everything else into {}", () => {
    const o = { a: 1 };
    expect(asObject(o)).toBe(o);
    for (const v of [null, undefined, 7, "x", true, [], [1]]) expect(asObject(v)).toEqual({});
  });
  it("asArray keeps an array and turns everything else into []", () => {
    const a = [1, 2];
    expect(asArray(a)).toBe(a);
    for (const v of [null, undefined, 7, "x", {}, { length: 1 }]) expect(asArray(v)).toEqual([]);
  });
  it("asText keeps a non-empty string and otherwise gives the fallback", () => {
    expect(asText("x", "f")).toBe("x");
    for (const v of ["", null, undefined, 5, {}, []]) expect(asText(v, "f")).toBe("f");
  });
});
