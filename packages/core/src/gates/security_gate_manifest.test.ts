// A10 (problem catalogue 2026-11-07): a package.json the gate cannot parse used to be skipped with no finding, so the dependency
// (typosquat) check read as clean when it had not run. The gate already reports an over-long line the same way ("Scan Limit").
import { describe, it } from "node:test";
import { expect } from "expect";
import { runSecurityGate } from "./security_gate";
import { isolateCwdForFile } from "../test-support/isolated_cwd.js";

isolateCwdForFile();

describe("security gate: a package.json it cannot read is reported, not skipped", () => {
  it("adds a Scan Limit finding that says the dependencies were not checked", () => {
    const res = runSecurityGate([{ path: "package.json", content: '{ "dependencies": { "lodas": "^1.0.0" ' }]);
    const f = res.findings.find((x) => x.category === "Scan Limit");
    expect(f).toBeDefined();
    expect(f!.path).toBe("package.json");
    expect(f!.message).toContain("not valid JSON");
    expect(f!.message).toContain("not checked");
  });
  it("does not block on it by itself (same severity as the over-long-line finding)", () => {
    const res = runSecurityGate([{ path: "package.json", content: "{" }]);
    expect(res.blocked).toBe(false);
  });
  it("stays silent on a valid package.json with a normal dependency", () => {
    const res = runSecurityGate([{ path: "package.json", content: JSON.stringify({ dependencies: { express: "^4.0.0" } }) }]);
    expect(res.findings.filter((x) => x.category === "Scan Limit")).toEqual([]);
  });
  it("still finds a typosquat in a valid package.json", () => {
    const res = runSecurityGate([{ path: "package.json", content: JSON.stringify({ dependencies: { lodas: "^1.0.0" } }) }]);
    expect(res.findings.some((x) => x.category === "Typosquatting Risk")).toBe(true);
  });
});
