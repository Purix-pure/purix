// src/gates/security_gate_r1d.test.ts
//
// R1-d (plan v6, F03-05 remainder): a file type the code rules have no rules for (Go, Rust, Ruby, PHP, HTML, Makefile) used to be read
// with the JavaScript rules and looked like a clean read. It is still read that way (HTML carries inline scripts; an unknown type must not
// be a way around the gate) but is now listed, so the result says it was read with the JavaScript rules only.
import { describe, it } from "node:test";
import { expect } from "expect";
import { runSecurityGate } from "./security_gate";

const gate = (path: string, content: string) => runSecurityGate([{ path, content }]);

describe("R1-d: types with no code rules are listed, and still read", () => {
  const PATHS = ["main.go", "lib.rs", "app.rb", "index.php", "page.html", "page.htm", "Makefile", "sub/Makefile", "rules.mk"];
  for (const path of PATHS) {
    it(`${path}: listed, and still read with the JavaScript rules`, () => {
      const r = gate(path, "exec(cmd + y)\n");
      expect(r.blocked).toBe(true);
      expect(r.notRead.map((n) => n.path)).toEqual([path]);
      expect(r.notRead[0]?.reason).toContain("no code rules");
    });
  }
  it("a secret in a Go file is still blocked", () => {
    expect(gate("main.go", 'const k = "AKIAIOSFODNN7EXAMPLX"').blocked).toBe(true);
  });
  it("TypeScript and JavaScript are still read by the code rules and not listed", () => {
    expect(gate("a.ts", "x = 1").notRead).toEqual([]);
    expect(gate("a.js", "x = 1").notRead).toEqual([]);
    expect(gate("a.ts", "exec(cmd + y)").blocked).toBe(true);
  });
  it("an unknown extension is still read with the JavaScript rules (no way around the gate)", () => {
    expect(gate("a.unknownext", "exec(cmd + y)").blocked).toBe(true);
  });
  it("a name that only ends like a Makefile is not treated as one", () => {
    expect(gate("notmakefile.ts", "exec(cmd + y)").blocked).toBe(true);
  });
});
