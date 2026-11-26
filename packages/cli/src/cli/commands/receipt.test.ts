// `purix receipt`: the Markdown is a pure function of the receipt lines, so the wording is tested without a store.
import { describe, test } from "node:test";
import { expect } from "expect";
import type { ChangeRecord } from "@purix/core/observe/ledger_reader";
import { receiptMarkdown } from "./receipt";

const change = { changeId: "chg-abc123" } as ChangeRecord;
const lines: [string, string][] = [["Change", "modify"], ["Checked", "checks passed"], ["Not checked", "nothing recorded as unchecked for this change (this does not mean everything was checked)"]];

describe("receiptMarkdown", () => {
  test("holds the receipt lines in a text block, with the chain head to compare with the commit trailer", () => {
    const md = receiptMarkdown({ change, lines, chain: { valid: true, recordCount: 12 }, headHash: "ab12", version: "9.9.9" });
    expect(md).toContain("### Purix receipt for change `chg-abc123`");
    expect(md).toContain("```text\nChange       modify");
    expect(md).toContain("`sha256:ab12`");
    expect(md).toContain("Chain: intact over 12 records");
    expect(md).toContain("Purix-Evidence");
    expect(md).toContain("Purix 9.9.9");
  });
  test("always says what a pass does not mean, and keeps the Not checked line", () => {
    const md = receiptMarkdown({ change, lines, chain: null, headHash: null, version: "1" });
    expect(md).toContain("does not mean the code is correct or safe");
    expect(md).toContain("Not checked");
    expect(md).toContain("not checked (this change did not land)");
    expect(md).toContain("Chain head: not read");
  });
  test("a broken chain is stated, never softened", () => {
    expect(receiptMarkdown({ change, lines, chain: { valid: false }, headHash: "x", version: "1" })).toContain("Chain: NOT intact");
  });
});
