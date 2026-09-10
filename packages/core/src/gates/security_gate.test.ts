// src/gates/security_gate.test.ts
import { describe, it } from "node:test";
import { expect } from "expect";
import { runSecurityGate, GOLDEN_CORPUS, setSecurityOverride } from "./security_gate";
import { getOverrideAudits } from "../security/override_audit";

describe("ADR-036 Deterministic Security Gate", () => {
  it("stays silent on clean code", () => {
    const res = runSecurityGate([
      { path: "src/safe.ts", content: 'export function add(a: number, b: number) { return a + b; }\n' },
    ]);
    expect(res.ok).toBe(true);
    expect(res.blocked).toBe(false);
    expect(res.findings.length).toBe(0);
  });

  it("catches SQL injection and blocks (Critical)", () => {
    const res = runSecurityGate([
      { path: "src/db.ts", content: 'const res = db.query("SELECT * FROM users WHERE id = " + userId);\n' },
    ]);
    expect(res.ok).toBe(false);
    expect(res.blocked).toBe(true);
    expect(res.findings.some((f) => f.category === "SQL Injection" && f.severity === "Critical")).toBe(true);
  });

  it("catches hardcoded secrets and blocks unconditionally", () => {
    const res = runSecurityGate([
      { path: "src/config.ts", content: 'const awsKey = "AKIAIOSFODNN7EXAMPLE";\n' },
    ]);
    expect(res.ok).toBe(false);
    expect(res.blocked).toBe(true);
    expect(res.findings.some((f) => f.category === "Hardcoded Secret" && f.severity === "Critical")).toBe(true);
  });

  it("catches weak crypto and blocks (High)", () => {
    const res = runSecurityGate([
      { path: "src/hash.ts", content: 'const h = crypto.createHash("md5").update(val);\n' },
    ]);
    expect(res.ok).toBe(false);
    expect(res.blocked).toBe(true);
    expect(res.findings.some((f) => f.category === "Weak Cryptography" && f.severity === "High")).toBe(true);
  });

  it("catches command injection", () => {
    const res = runSecurityGate([
      { path: "src/cmd.ts", content: 'exec("rm -rf " + dir);\n' },
    ]);
    expect(res.blocked).toBe(true);
  });

  it("catches unsafe deserialization", () => {
    const res = runSecurityGate([
      { path: "src/eval.ts", content: 'vm.runInNewContext(code);\n' },
    ]);
    expect(res.blocked).toBe(true);
  });

  it("catches potential typosquatting in package.json", () => {
    const res = runSecurityGate([
      { path: "package.json", content: JSON.stringify({ dependencies: { "lodas": "^1.0.0" } }) },
    ]);
    expect(res.ok).toBe(false);
    expect(res.blocked).toBe(true);
    expect(res.findings.some((f) => f.category === "Typosquatting Risk")).toBe(true);
  });

  it("golden-set corpus regression check runs successfully", () => {
    for (const item of GOLDEN_CORPUS) {
      const res = runSecurityGate([{ path: "src/test.ts", content: item.code }]);
      if (item.shouldBlock) {
        expect(res.blocked).toBe(true);
      } else {
        expect(res.blocked).toBe(false);
      }
    }
  });
});

describe("security gate override with audit", () => {
  it("blocks Critical finding with no override", () => {
    const res = runSecurityGate([
      { path: "src/db.ts", content: 'const res = db.query("SELECT * FROM users WHERE id = " + userId);\n' },
    ]);
    expect(res.blocked).toBe(true);
  });

  it("proceeds and records override audit when override is present with a real reason", () => {
    setSecurityOverride("Testing security gate override");
    const res = runSecurityGate([
      { path: "src/db.ts", content: 'const res = db.query("SELECT * FROM users WHERE id = " + userId);\n' },
    ]);
    expect(res.blocked).toBe(false);
    expect(res.ok).toBe(true);

    const audits = getOverrideAudits();
    const secAudit = audits.find(a => a.gate_name === "SecurityGate");
    expect(secAudit).toBeTruthy();
    expect(secAudit?.reason).toBe("Testing security gate override");
  });

  it("rejects an empty-string override reason", () => {
    setSecurityOverride("   ");
    expect(() => runSecurityGate([
      { path: "src/db.ts", content: 'const res = db.query("SELECT * FROM users WHERE id = " + userId);\n' },
    ])).toThrow(/reason cannot be empty/);
  });
});
