// A secret-scan or security-gate stop is recorded as a structured event, so a stopped change can be told apart from a failed test.
// The detail holds names and counts only: never a matched value, never a message that quotes the code.
import { describe, it } from "node:test";
import { expect } from "expect";
import { secretBlockDetail, securityGateBlockDetail } from "./policy_block_detail.js";

describe("secretBlockDetail", () => {
  it("counts findings by pattern name and lists files, with no matched text", () => {
    const d = secretBlockDetail([
      { path: "a.ts", line: 3, match: "AKIA...WXYZ", reason: "AWS access key" },
      { path: "a.ts", line: 9, match: "AKIA...1234", reason: "AWS access key" },
      { path: "b.ts", line: 1, match: "abcd...wxyz", reason: "high-entropy string, possible secret" },
    ]);
    expect(d.source).toBe("secret_scan");
    expect(d.findings).toBe(3);
    expect(d.categories).toEqual({ "AWS access key": 2, "high-entropy string, possible secret": 1 });
    expect(d.files).toEqual(["a.ts", "b.ts"]);
    expect(JSON.stringify(d)).not.toContain("AKIA");
  });

  it("keeps at most 10 files and says how many findings there were", () => {
    const many = Array.from({ length: 14 }, (_, i) => ({ path: `f${i}.ts`, line: 1, match: "x...y", reason: "r" }));
    const d = secretBlockDetail(many);
    expect(d.files.length).toBe(10);
    expect(d.findings).toBe(14);
  });
});

describe("securityGateBlockDetail", () => {
  const f = (category: string, severity: "Critical" | "High" | "Medium" | "Low", path = "a.ts") => ({ path, line: 1, category, severity, message: "Hardcoded secret detected (x): sk-live-SECRETVALUE" });

  it("counts only the findings that block, by category, and never copies the message", () => {
    const d = securityGateBlockDetail([f("SQL Injection", "High"), f("SQL Injection", "Critical", "b.ts"), f("Weak Cryptography", "Medium"), f("Command/Code Injection", "High")]);
    expect(d.source).toBe("security_gate");
    expect(d.findings).toBe(3);
    expect(d.categories).toEqual({ "SQL Injection": 2, "Command/Code Injection": 1 });
    expect(d.files).toEqual(["a.ts", "b.ts"]);
    expect(JSON.stringify(d)).not.toContain("SECRETVALUE");
  });

  it("with nothing blocking it reports zero findings", () => {
    expect(securityGateBlockDetail([f("Weak Cryptography", "Low")]).findings).toBe(0);
  });
});
