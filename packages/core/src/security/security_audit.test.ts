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
});
