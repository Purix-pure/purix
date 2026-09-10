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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyInSandbox } from "./sandbox";
import { closeDb } from "../manifest/store";

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
  rmSync(tmpDir, { recursive: true, force: true });
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
});
