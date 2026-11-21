// src/security/security_audit.test.ts
import { describe, it } from "node:test";
import { expect } from "expect";
import { auditSecurityPatterns } from "./security_audit";

describe("Security Audit Patterns", () => {
  it("flags route handlers without rate limits and body access without validation", () => {
    const findings = auditSecurityPatterns([
      { path: "src/routes/bad.ts", content: 'app.post("/api", (req, res) => { const data = req.body; });\n' },
    ]);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some((f) => f.category === "rate_limiting")).toBe(true);
    expect(findings.some((f) => f.category === "input_validation")).toBe(true);
  });

  it("does not flag routes with rate limits and validation", () => {
    const findings = auditSecurityPatterns([
      { path: "src/routes/good.ts", content: 'const limiter = rateLimit(); app.post("/api", limiter, (req, res) => { const data = schema.parse(req.body); });\n' },
    ]);
    expect(findings.filter((f) => f.category === "rate_limiting" || f.category === "input_validation").length).toBe(0);
  });

  const evalFindings = (path: string, content: string) => auditSecurityPatterns([{ path, content }]).filter((f) => f.category === "dangerous_eval");

  it("still flags a real eval call, window.eval and new Function", () => {
    expect(evalFindings("a.ts", "const r = eval(code);\n").length).toBe(1);
    expect(evalFindings("a.ts", "window.eval(code);\n").length).toBe(1);
    expect(evalFindings("a.ts", "const f = new Function('a', body);\n").length).toBe(1);
    expect(evalFindings("a.ts", "x = 1; eval (y)\n").length).toBe(1);
  });

  it("does not flag eval( written in a line comment, a block comment or a string", () => {
    // The dry run on the security gate flagged this kind of line: a comment that talks about eval(.
    expect(evalFindings("gate.ts", "// C4: exec( or eval( that sits inside a quoted string is text, not a call.\n").length).toBe(0);
    expect(evalFindings("a.ts", "/* never call eval( here */ const a = 1;\n").length).toBe(0);
    expect(evalFindings("a.ts", "/*\n * eval(x) is unsafe\n */\nconst a = 1;\n").length).toBe(0);
    expect(evalFindings("a.ts", 'log("do not use eval(x)");\n').length).toBe(0);
    expect(evalFindings("a.ts", "const m = `avoid new Function(`;\n").length).toBe(0);
    expect(evalFindings("a.py", "# eval(x) would be unsafe\n").length).toBe(0);
  });

  it("does not flag a method that is merely named eval", () => {
    expect(evalFindings("a.ts", "await redis.eval(script, 0);\n").length).toBe(0);
    expect(evalFindings("a.py", "model.eval()\n").length).toBe(0);
  });

  it("flags code that follows a comment or string on the same line", () => {
    expect(evalFindings("a.ts", "/* ok */ eval(x);\n").length).toBe(1);
    expect(evalFindings("a.ts", 'const s = "a"; eval(s);\n').length).toBe(1);
  });

  it("an eval after a closed block comment on a later line is still read as code", () => {
    expect(evalFindings("a.ts", "/* start\nend */ eval(x);\n").length).toBe(1);
  });
});
