// src/verify/surface_text.test.ts
import { describe, it } from "node:test";
import { expect } from "expect";
import { excludedForSafetyMessage } from "./surface_text";

// C3 item 2 (plan v4): credential-looking files left out of the verification copy must reach a person on a PASS, not only inside a failure.
describe("excludedForSafetyMessage", () => {
  it("is silent when nothing was left out", () => {
    expect(excludedForSafetyMessage(undefined)).toBeUndefined();
    expect(excludedForSafetyMessage([])).toBeUndefined();
  });
  it("names the files and says what a pass does not cover", () => {
    const m = excludedForSafetyMessage([".npmrc", "server.pem"])!;
    expect(m).toContain(".npmrc, server.pem");
    expect(m).toMatch(/does not cover that/);
  });
  it("shortens a long list", () => {
    expect(excludedForSafetyMessage(["a", "b", "c", "d", "e", "f", "g"])).toContain("and 2 more");
  });
});

import { securityNotesMessages } from "./surface_text";
describe("securityNotesMessages (C4)", () => {
  it("says nothing when there is nothing", () => {
    expect(securityNotesMessages(undefined, undefined)).toEqual([]);
    expect(securityNotesMessages([], [])).toEqual([]);
  });
  it("names advisories and unread files, and says secrets are still scanned", () => {
    const m = securityNotesMessages([{ path: "a.ts", line: 3, category: "Scan Limit" }], [{ path: "a.json", reason: "data" }, { path: "b.md", reason: "documentation" }]);
    expect(m[0]).toContain("Scan Limit in a.ts:3");
    expect(m[1]).toContain("a.json, b.md");
    expect(m[1]).toContain("Secrets are still scanned in every file");
  });
  it("caps long lists", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ path: `f${i}.json`, reason: "data" }));
    expect(securityNotesMessages(undefined, many)[0]).toContain("and 3 more");
  });
});

describe("securityNotesMessages: dependency notes (F03-02)", () => {
  it("a not-checked dependency note says not checked, and that it is not a clean result", () => {
    const m = securityNotesMessages([{ path: "package.json", line: 1, category: "Dependency Check" }], undefined);
    expect(m).toHaveLength(1);
    expect(m[0]).toContain("not checked");
    expect(m[0]).toContain("not a clean result");
    expect(m[0]).toContain("package.json");
  });
  it("a known-vulnerability note is its own line", () => {
    const m = securityNotesMessages([{ path: "package.json", line: 1, category: "Known Vulnerability" }], undefined);
    expect(m[0]).toContain("known vulnerabilities");
  });
  it("other advisories keep their old line", () => {
    const m = securityNotesMessages([{ path: "a.ts", line: 3, category: "Scan Limit" }, { path: "package.json", line: 1, category: "Dependency Check" }], undefined);
    expect(m[0]).toContain("Scan Limit in a.ts:3");
    expect(m).toHaveLength(2);
  });
});
