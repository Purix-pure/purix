// src/security/secrets.test.ts
//
// scanForSecrets() and scrubSecrets() had no dedicated test coverage at
// all before this — every other file that calls them (sandbox.ts,
// scaffold.ts, migration.ts, escalate.ts's outbound scrub) only
// exercised them indirectly through much larger integration tests. Given
// this is the one mechanism ADR-025 and ADR-037 both depend on to keep a
// real credential out of a commit, it earns direct, standalone coverage
// of its own rather than staying implicitly tested through everything
// that happens to call it.
import { describe, it } from "node:test";
import { expect } from "expect";
import { scanForSecrets, scrubSecrets } from "./secrets";

describe("scanForSecrets", () => {
  it("flags an AWS access key", () => {
    const findings = scanForSecrets([{ path: "config.ts", content: `const key = "AKIAIOSFODNN7EXAMPLE";` }]);
    expect(findings.length).toBe(1);
    expect(findings[0]!.reason).toBe("AWS Access Key");
    expect(findings[0]!.path).toBe("config.ts");
  });

  it("flags a private key block", () => {
    const findings = scanForSecrets([
      { path: "id_rsa", content: "-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\n-----END RSA PRIVATE KEY-----" },
    ]);
    expect(findings.some((f) => f.reason === "Private key block")).toBe(true);
  });

  it("flags a high-entropy quoted string even with no known-format match", () => {
    const findings = scanForSecrets([
      { path: "config.ts", content: `const token = "xK9mQ2vN8pL4wR7tY1zA5bC3dE6fG0hJ9k";` },
    ]);
    expect(findings.some((f) => f.reason.includes("high-entropy"))).toBe(true);
  });

  it("does not flag an ordinary low-entropy quoted string", () => {
    const findings = scanForSecrets([
      { path: "config.ts", content: `const greeting = "hello world this is just a normal string";` },
    ]);
    expect(findings.length).toBe(0);
  });

  it("reports the correct 1-indexed line number", () => {
    const findings = scanForSecrets([
      { path: "f.ts", content: `line one\nline two\nconst key = "AKIAIOSFODNN7EXAMPLE";\nline four` },
    ]);
    expect(findings[0]!.line).toBe(3);
  });

  it("redacts the reported match rather than including it verbatim", () => {
    const findings = scanForSecrets([{ path: "f.ts", content: `const key = "AKIAIOSFODNN7EXAMPLE";` }]);
    expect(findings[0]!.match).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(findings[0]!.match).toContain("...");
  });

  it("scans every file independently and attributes findings to the right path", () => {
    const findings = scanForSecrets([
      { path: "clean.ts", content: `const x = 1;` },
      { path: "dirty.ts", content: `const key = "AKIAIOSFODNN7EXAMPLE";` },
    ]);
    expect(findings.length).toBe(1);
    expect(findings[0]!.path).toBe("dirty.ts");
  });
});

describe("scrubSecrets", () => {
  it("redacts a match in place and reports a nonzero scrubbedCount, rather than blocking", () => {
    const [result] = scrubSecrets([{ path: "neighbor.ts", content: `const key = "AKIAIOSFODNN7EXAMPLE";` }]);
    expect(result!.scrubbedCount).toBe(1);
    expect(result!.content).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(result!.content).toContain("[REDACTED:AWS Access Key]");
  });

  it("redacts every occurrence on a line, not just the first", () => {
    const [result] = scrubSecrets([
      { path: "f.ts", content: `Bearer aaaaaaaaaaaaaaaaaaaaaaaa and Bearer bbbbbbbbbbbbbbbbbbbbbbbb` },
    ]);
    expect(result!.scrubbedCount).toBe(2);
  });

  it("leaves clean content completely unchanged", () => {
    const [result] = scrubSecrets([{ path: "f.ts", content: `export function add(a: number, b: number) { return a + b; }` }]);
    expect(result!.scrubbedCount).toBe(0);
    expect(result!.content).toBe(`export function add(a: number, b: number) { return a + b; }`);
  });

  it("uses the same pattern list as scanForSecrets (no drift between scrub and scan)", () => {
    const content = `const key = "AKIAIOSFODNN7EXAMPLE";`;
    const findings = scanForSecrets([{ path: "f.ts", content }]);
    const [scrubbed] = scrubSecrets([{ path: "f.ts", content }]);
    // Anything scanForSecrets would flag, scrubSecrets should have
    // already redacted — if these ever disagree, the two pattern lists
    // have drifted apart, which is exactly what reusing PATTERNS is
    // supposed to prevent.
    expect(findings.length).toBeGreaterThan(0);
    expect(scrubbed!.scrubbedCount).toBeGreaterThan(0);
  });
});
