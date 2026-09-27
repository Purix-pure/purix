// TEST-REPORT F9: a model that answers in prose must produce a plain, actionable Error — not a raw SyntaxError.
import { describe, it } from "node:test";
import { expect } from "expect";
import { z } from "zod";
import { parseModelJson } from "./classify";

const Schema = z.object({ name: z.string() });

describe("parseModelJson", () => {
  it("parses fenced JSON", () => {
    expect(parseModelJson('```json\n{"name":"x"}\n```', Schema, "test")).toEqual({ name: "x" });
  });
  it("turns a prose reply into a plain Error that quotes how the reply began", () => {
    let caught: unknown;
    try {
      parseModelJson("Sure! Here is the change you asked for", Schema, "change classification");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    // reportCommandFailure() only treats a *plain* Error as an expected failure (not "Unhandled error").
    expect((caught as Error).constructor).toBe(Error);
    expect((caught as Error).message).toContain("not valid JSON");
    expect((caught as Error).message).toContain("Sure! Here");
    expect((caught as Error).message).toContain("Nothing was changed");
  });
  it("reports a wrong shape as a plain Error naming the bad field", () => {
    let caught: unknown;
    try {
      parseModelJson('{"name": 5}', Schema, "planning");
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).constructor).toBe(Error);
    expect((caught as Error).message).toContain("did not match the expected shape");
    expect((caught as Error).message).toContain("name");
  });
});
