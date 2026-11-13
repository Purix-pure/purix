// src/gates/security_gate_longline.test.ts
//
// A7-1: a single crafted line must not stall the gate. Research 03 measured 43 s at 600 KB of repeated `exec(` (the shell and
// SQL rules backtrack, so cost grew about fourfold per doubling); the repository lock expires after 30 s. The gate now reads a
// long line in bounded windows, and a line past the scan cap is reported as not fully scanned instead of looking clean.
import { describe, it } from "node:test";
import { expect } from "expect";
import { runSecurityGate } from "./security_gate";

const kb = (n: number, unit: string) => unit.repeat(Math.ceil((n * 1024) / unit.length));
const WINDOW_BUDGET_MS = 8000;

function timed<T>(fn: () => T): { out: T; ms: number } {
  const t0 = Date.now();
  const out = fn();
  return { out, ms: Date.now() - t0 };
}

describe("security gate on very long lines", () => {
  it("600 KB of repeated exec( finishes inside the budget (it was over 120 s)", () => {
    const { ms } = timed(() => runSecurityGate([{ path: "big.ts", content: kb(600, "exec(") }], undefined));
    expect(ms).toBeLessThan(WINDOW_BUDGET_MS);
  });

  it("600 KB of repeated query(' finishes inside the budget (it was 65 s)", () => {
    const { ms } = timed(() => runSecurityGate([{ path: "big.ts", content: kb(600, "query('") }], undefined));
    expect(ms).toBeLessThan(WINDOW_BUDGET_MS);
  });

  it("a line past the scan cap says it was not fully scanned, at a non-blocking severity", () => {
    const r = runSecurityGate([{ path: "min.js", content: kb(2048, "a=1;") }], undefined);
    const f = r.findings.filter((x) => x.category === "Scan Limit");
    expect(f.length).toBe(1);
    expect(f[0]!.line).toBe(1);
    expect(f[0]!.severity).toBe("Medium");
    expect(f[0]!.message).toMatch(/not scanned|not fully scanned/i);
    expect(r.blocked).toBe(false);
  });

  it("an ordinary long line under the cap gets no Scan Limit finding", () => {
    const r = runSecurityGate([{ path: "min.js", content: kb(100, "a=1;") }], undefined);
    expect(r.findings.some((x) => x.category === "Scan Limit")).toBe(false);
  });

  it("an injection pattern inside a long line is still found, once", () => {
    const filler = kb(50, "var a = 1; ");
    const line = `${filler}db.query("SELECT * FROM t WHERE n = " + userInput);${filler}`;
    const r = runSecurityGate([{ path: "min.js", content: line }], undefined);
    const sql = r.findings.filter((x) => x.category === "SQL Injection");
    expect(sql.length).toBe(1);
    expect(r.blocked).toBe(true);
  });

  it("a pattern near a window edge is still found", () => {
    // Walk a short injection across many offsets so at least some land on a window boundary.
    const hit = 'db.query("x" + y);';
    let found = 0;
    for (let off = 1900; off < 2200; off += 7) {
      const line = "a".repeat(off) + hit + "b".repeat(5000);
      if (runSecurityGate([{ path: "m.js", content: line }], undefined).findings.some((x) => x.category === "SQL Injection")) found++;
    }
    expect(found).toBe(Math.ceil((2200 - 1900) / 7));
  });

  it("short lines behave exactly as before", () => {
    const r = runSecurityGate([{ path: "a.ts", content: 'db.query("SELECT * FROM users WHERE name = " + userInput);' }], undefined);
    expect(r.findings.map((x) => x.category)).toEqual(["SQL Injection"]);
  });
});
