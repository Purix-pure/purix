// src/security/secrets.test.ts
//
// scanForSecrets() and scrubSecrets() had no dedicated test coverage at
// all before this — every other file that calls them (sandbox.ts,
// scaffold.ts, migration.ts, escalate.ts's outbound scrub) only
// exercised them indirectly through much larger integration tests. Given
// this is the one mechanism ADR-003 and ADR-037 both depend on to keep a
// real credential out of a commit, it earns direct, standalone coverage
// of its own rather than staying implicitly tested through everything
// that happens to call it.
import { describe, it } from "node:test";
import { expect } from "expect";
import { scanForSecrets, scrubSecrets, isDocumentedExampleCredential } from "./secrets";

describe("scanForSecrets", () => {
  it("flags an AWS access key", () => {
    const findings = scanForSecrets([{ path: "config.ts", content: `const key = "AKIAIOSFODNN7EXAMPLX";` }]);
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
      { path: "f.ts", content: `line one\nline two\nconst key = "AKIAIOSFODNN7EXAMPLX";\nline four` },
    ]);
    expect(findings[0]!.line).toBe(3);
  });

  it("redacts the reported match rather than including it verbatim", () => {
    const findings = scanForSecrets([{ path: "f.ts", content: `const key = "AKIAIOSFODNN7EXAMPLX";` }]);
    expect(findings[0]!.match).not.toContain("AKIAIOSFODNN7EXAMPLX");
    expect(findings[0]!.match).toContain("...");
  });

  it("scans every file independently and attributes findings to the right path", () => {
    const findings = scanForSecrets([
      { path: "clean.ts", content: `const x = 1;` },
      { path: "dirty.ts", content: `const key = "AKIAIOSFODNN7EXAMPLX";` },
    ]);
    expect(findings.length).toBe(1);
    expect(findings[0]!.path).toBe("dirty.ts");
  });
});

describe("scrubSecrets", () => {
  it("redacts a match in place and reports a nonzero scrubbedCount, rather than blocking", () => {
    const [result] = scrubSecrets([{ path: "neighbor.ts", content: `const key = "AKIAIOSFODNN7EXAMPLX";` }]);
    expect(result!.scrubbedCount).toBe(1);
    expect(result!.content).not.toContain("AKIAIOSFODNN7EXAMPLX");
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
    const content = `const key = "AKIAIOSFODNN7EXAMPLX";`;
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

// Register item 13: the credentials AWS prints in its own documentation are not secrets, and a README or test fixture that quotes them
// must not block a change. Only the exact documented strings are skipped, and only by the blocking scan.
describe("documented AWS example credentials", () => {
  const ID = "AKIAIOSFODNN7EXAMPLE";
  const SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
  const scan = (content: string) => scanForSecrets([{ path: "f.ts", content }]);

  it("does not block the documented access key id or secret key, quoted or in an env line", () => {
    expect(scan(`const key = "${ID}";`)).toEqual([]);
    expect(scan(`const secret = "${SECRET}";`)).toEqual([]);
    expect(scan(`AWS_ACCESS_KEY_ID=${ID}`)).toEqual([]);
    expect(scan(`aws_secret_access_key = ${SECRET}`)).toEqual([]);
    expect(scan(`const k = "AKIAI44QH8DHBEXAMPLE"; const s = "je7MtGbClwBF/2Zp9Utk/h3yCo8nvbEXAMPLEKEY";`)).toEqual([]);
  });

  it("does not block the example when it is written as two joined pieces", () => {
    expect(scan(`const key = "AKIAIOSF" + "ODNN7EXAMPLE";`)).toEqual([]);
  });

  it("still blocks a real-looking key on the same line as an example", () => {
    const f = scan(`const a = "${ID}"; const b = "AKIAJ7ZQ3KLM5NPX2RTV";`);
    expect(f.length).toBe(1);
    expect(f[0]!.reason).toBe("AWS Access Key");
  });

  it("is an exact match: a one-character change, or the word EXAMPLE appended to something else, still blocks", () => {
    expect(scan(`const key = "AKIAIOSFODNN7EXAMPLX";`).length).toBe(1);
    expect(scan(`const key = "AKIAQWERTYUIOP12EXAMPLE";`).length).toBe(1);
    expect(isDocumentedExampleCredential("AKIAQWERTYUIOP12EXAMPLE")).toBe(false);
    expect(isDocumentedExampleCredential(ID)).toBe(true);
  });

  it("is not used by the redaction path: a prompt that leaves the machine never carries even the documented key", () => {
    const [r] = scrubSecrets([{ path: "n.ts", content: `const key = "${ID}";` }]);
    expect(r!.content).not.toContain(ID);
    expect(r!.scrubbedCount).toBeGreaterThan(0);
  });
});
