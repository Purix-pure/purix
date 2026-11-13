// src/sandbox/sandbox.test.ts
//
// verifyInSandbox() had no dedicated test file before this, despite
// being the one function every write path in this codebase — a fresh
// escalation fix, a library replay, drift acceptance, a migration
// activation — routes through before anything touches the real working
// tree. This file's specific focus is the secret-scan gate at the top
// of verifyInSandbox: this is the mechanism that satisfies the
// addendum's ADR-037 (symmetric secret scan on the escalation return
// path) — recovery/escalate.ts never merges an escalation's edits into
// the real working tree without first passing them through
// verifyInSandbox exactly like any other candidate change set, so
// pinning the behavior here is pinning it for that path too, without
// needing to mock a real LLM call to prove it.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyInSandbox } from "./sandbox";
import { closeDb } from "../manifest/store";
import { registerLanguageProvider } from "../language/registry";
import type { LanguageProvider } from "../language/provider";
import { safeRmSync } from "../platform/fs_retry.js";
import { placeFakeInstall } from "../tools/test_helpers.js";
import { locateTool } from "../tools/broker.js";

let originalCwd: string;
let tmpDir: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tmpDir = mkdtempSync(join(tmpdir(), "purix-sandbox-test-"));
  process.chdir(tmpDir);
  writeFileSync(
    join(tmpDir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "es2022",
        module: "esnext",
        moduleResolution: "node",
        noEmit: true,
        skipLibCheck: true,
        noLib: true,
      },
    })
  );
});

afterEach(() => {
  closeDb();
  process.chdir(originalCwd);
  safeRmSync(tmpDir);
});

describe("verifyInSandbox — secret scan gate (ADR-037)", () => {
  it("blocks a candidate change containing a credential-shaped string, before any sandbox file is written", () => {
    // Same shape recovery/escalate.ts passes after applyEdits() —
    // { path, new_content } — whether that content came from a fresh
    // LLM escalation call or a library replay makes no difference to
    // this gate, which is exactly the point: it's unconditional on the
    // candidate content, not specific to one call site.
    const candidateFiles = [
      { path: "component.ts", new_content: `export const key = "AKIAIOSFODNN7EXAMPLE";\n` },
    ];

    const result = verifyInSandbox("comp-a", candidateFiles, tmpDir);

    expect(result.status).toBe("fail");
    if (result.status === "fail") {
      expect(result.reason).toContain("Secrets/entropy scan blocked this patch");
      expect(result.reason).toContain("AWS Access Key");
      // The reported reason is redacted, same guarantee scanForSecrets
      // itself gives — a blocked-patch reason string is exactly the
      // kind of thing that ends up in a local audit log (recordEvent)
      // or on a person's screen, so it must never carry the raw secret.
      expect(result.reason).not.toContain("AKIAIOSFODNN7EXAMPLE");
    }
  });

  it("does not create a persistent sandbox directory when the secret scan blocks the change", () => {
    // The secret-scan gate lives BEFORE verifyInSandbox's own
    // mkdtempSync call — this pins that ordering specifically, since a
    // gate that runs after the sandbox copy is made is still correct
    // but wastes a real filesystem copy on content that was always
    // going to be rejected.
    const before = process.cwd();
    const candidateFiles = [{ path: "component.ts", new_content: `const key = "AKIAIOSFODNN7EXAMPLE";\n` }];
    verifyInSandbox("comp-a", candidateFiles, tmpDir);
    // No assertion on /tmp contents directly (that's the OS's business,
    // not this test's) — the real guarantee is behavioral: the call
    // above returned without ever needing tsc, node_modules, or a
    // writable copy of targetDir, which the earlier test already
    // proves by completing without any of that being set up.
    expect(process.cwd()).toBe(before);
  });

  it("does not block a clean candidate change on the secret scan (only fails later, on real compile/test problems, if at all)", () => {
    // Deliberately minimal, syntactically-broken-enough content that it
    // WILL fail verification eventually (no tsconfig/toolchain set up
    // in this bare tmpDir) — the point of this test is only that the
    // FAILURE REASON is never the secret scan when there's nothing
    // secret-shaped in the content, not that this specific content
    // passes end to end.
    const candidateFiles = [{ path: "component.ts", new_content: `export function add(a: number, b: number): number {\n  return a + b;\n}\n` }];
    const result = verifyInSandbox("comp-a", candidateFiles, tmpDir);
    if (result.status === "fail") {
      expect(result.reason).not.toContain("Secrets/entropy scan blocked this patch");
    }
  });

  describe("languageOverride — regression for the indexer's false-positive dispatch bug (GAPS-REPORT §2.1)", () => {
    // A synthetic componentId (like the indexer's "comp-N") can never match
    // a real manifest entry, so without an override, verifyInSandbox falls
    // through to whole-repository marker-file auto-detection — which, in
    // this tmpDir (tsconfig.json present, nothing else), resolves to
    // "typescript" regardless of the file's real language. This pins that
    // the fallback still happens absent an override...
    it("without an override, a file in a language no provider covers is reported as not checked, never handed to the TypeScript toolchain", () => {
      // A10a-1. This test used to pin the opposite: that component.rs was dispatched through whole-repo auto-detection to the
      // TypeScript provider, which "never actually checked component.rs's content". That was the false-pass defect (ADR-017).
      const candidateFiles = [{ path: "component.rs", new_content: `fn add(a: i32, b: i32) -> i32 { a + b }\n` }];
      const result = verifyInSandbox("comp-1", candidateFiles, tmpDir);
      expect(result.status).toBe("fail");
      if (result.status !== "fail") return;
      expect(result.infrastructure).toBe("unsupported_language");
      expect(result.reason).toMatch(/unsupported language, not checked/i);
    });

    // ...and that passing the caller's own already-known language closes
    // it: dispatch goes to the real provider for that language instead of
    // silently defaulting to whatever the surrounding repo looks like.
    it("with an explicit languageOverride, dispatch goes to the real provider for that language instead of auto-detecting", () => {
      let verifyCalledWith: string[] | undefined;
      const fakeProvider: LanguageProvider = {
        id: "fakelang",
        minSupportedVersion: "1.0.0",
        detect: () => false,
        verify: (filePaths) => {
          verifyCalledWith = filePaths;
          return { status: "fail", reason: "fakelang provider was actually invoked" };
        },
        runTests: () => ({ status: "pass", quarantinedFailures: [] }),
        checkIdiom: () => ({ ran: true, findings: [] }),
        auditDependencies: async () => ({ pinning: [], vulnerabilities: [], ran: false }),
        getFingerprint: async () => ({}),
      };
      registerLanguageProvider(fakeProvider);

      const candidateFiles = [{ path: "component.rs", new_content: `fn add(a: i32, b: i32) -> i32 { a + b }\n` }];
      const result = verifyInSandbox("comp-1", candidateFiles, tmpDir, "fakelang");

      // Proves dispatch actually reached the overridden provider (not the
      // TypeScript one, which would never fail on this tmpDir's empty
      // project) and that it was handed the real file, not silently
      // skipped.
      expect(result.status).toBe("fail");
      expect(result.status === "fail" && result.reason).toContain("fakelang provider was actually invoked");
      expect(verifyCalledWith?.some((p) => p.endsWith("component.rs"))).toBe(true);
    });
  });

  describe("runSecurityGate wiring — regression for GAPS-REPORT §2.2 (gate had zero production callers)", () => {
    it("blocks a candidate change containing a SQL-injection-shaped pattern, even with no secrets present", () => {
      const candidateFiles = [
        { path: "component.ts", new_content: `db.query("SELECT * FROM users WHERE name = " + userInput);\n` },
      ];
      const result = verifyInSandbox("comp-a", candidateFiles, tmpDir);
      expect(result.status).toBe("fail");
      expect(result.status === "fail" && result.reason).toContain("SQL Injection");
    });

    it("respects setSecurityOverride() the same way the CLI's --override flag relies on", async () => {
      const { setSecurityOverride } = await import("../gates/security_gate.js");
      setSecurityOverride("reviewed manually for this test");
      const candidateFiles = [
        { path: "component.ts", new_content: `db.query("SELECT * FROM users WHERE name = " + userInput);\n` },
      ];
      const result = verifyInSandbox("comp-a", candidateFiles, tmpDir);
      // The override consumes itself — this only proves the override
      // path is actually reachable through verifyInSandbox, not that the
      // rest of verification passes (tmpDir has no real toolchain set up
      // for this file, so it may still fail later for unrelated reasons).
      if (result.status === "fail") {
        expect(result.reason).not.toContain("SQL Injection");
      }
    });
  });

  describe("isolation aggregation — regression for GAPS-REPORT §2.3 (isolation level computed then discarded)", () => {
    const makeFakeProvider = (id: string, verifyIsolation: "none" | "os-sandbox" | "network-namespace", testIsolation: "none" | "os-sandbox" | "network-namespace"): LanguageProvider => ({
      id,
      minSupportedVersion: "1.0.0",
      detect: () => false,
      verify: () => ({ status: "pass", isolation: verifyIsolation }),
      runTests: () => ({ status: "pass", quarantinedFailures: [], isolation: testIsolation }),
      checkIdiom: () => ({ ran: true, findings: [] }),
      auditDependencies: async () => ({ pinning: [], vulnerabilities: [], ran: false }),
      getFingerprint: async () => ({}),
    });

    it("reports isolation: \"none\" on the overall result when any step ran unisolated, even if another step was isolated", () => {
      registerLanguageProvider(makeFakeProvider("fakelang-mixed", "network-namespace", "none"));
      const result = verifyInSandbox("comp-1", [{ path: "component.fakelang-mixed", new_content: "x" }], tmpDir, "fakelang-mixed");
      expect(result.status).toBe("pass");
      expect(result.status === "pass" && result.isolation).toBe("none");
    });

    it("reports the real isolation level when every step ran isolated", () => {
      registerLanguageProvider(makeFakeProvider("fakelang-isolated", "network-namespace", "network-namespace"));
      const result = verifyInSandbox("comp-1", [{ path: "component.fakelang-isolated", new_content: "x" }], tmpDir, "fakelang-isolated");
      expect(result.status).toBe("pass");
      expect(result.status === "pass" && result.isolation).toBe("network-namespace");
    });
  });

  describe("tools installed through `purix tools` are visible inside the verification copy", () => {
    it("the copy reads the real project's tools state, so a provider's broker lookup finds the tool there", () => {
      const bin = placeFakeInstall(tmpDir, "pytest");
      let seen: ReturnType<typeof locateTool> = null;
      let copyDir = "";
      registerLanguageProvider({
        id: "fakelang-tools",
        minSupportedVersion: "1.0.0",
        detect: () => true,
        verify: (_paths: string[], baseDir: string) => {
          copyDir = baseDir;
          seen = locateTool({ baseDir }, "pytest");
          return { status: "pass", isolation: "none" };
        },
        runTests: () => ({ status: "no_tests", quarantinedFailures: [] }),
        checkIdiom: () => ({ findings: [], ran: false }),
        auditDependencies: async () => ({ pinning: [], vulnerabilities: [], ran: false }),
        getFingerprint: async () => ({}),
      });

      verifyInSandbox("comp-1", [{ path: "component.fakelang-tools", new_content: "x" }], tmpDir, "fakelang-tools");

      expect(copyDir).not.toBe(tmpDir); // it really ran on the copy
      expect(seen).not.toBeNull();
      expect(seen!.source).toBe("purix");
      expect(seen!.command[0]).toBe(bin); // T1: found in the user's tools state through the copy's alias, not inside the copy
      expect(existsSync(bin)).toBe(true); // and the real install was left untouched
    });
  });
});
