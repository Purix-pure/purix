// src/result_line.test.ts
import { describe, it } from "node:test";
import { expect } from "expect";
import { DATA_NOTICE, withResultLine } from "./server.js";

describe("withResultLine", () => {
  it("leaves JSON, read-only tools and an empty record untouched", () => {
    const json = { content: [{ type: "text" as const, text: '{"ok":true}' }] };
    expect(withResultLine("purix_modify", json, "chg-x")).toBe(json);
    const prose = { content: [{ type: "text" as const, text: "hello" }] };
    expect(withResultLine("purix_status", prose, "chg-x")).toBe(prose);
    // a project with no record has nothing to say, so the reply is returned as it was
    expect(withResultLine("purix_modify", prose, "chg-x").content[0]!.text).toBe("hello");
  });
});
void DATA_NOTICE;
