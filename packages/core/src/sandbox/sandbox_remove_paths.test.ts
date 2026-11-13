// Plan 0.4: a deleted file must be gone from the verification copy, or an import of it passes here and breaks after the change lands.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { verifyInSandbox } from "./sandbox";
import { closeDb } from "../manifest/store";
import { registerLanguageProvider } from "../language/registry";
import type { LanguageProvider } from "../language/provider";
import { safeRmSync } from "../platform/fs_retry.js";

let originalCwd: string;
let tmpDir: string;
beforeEach(() => {
  originalCwd = process.cwd();
  tmpDir = mkdtempSync(join(tmpdir(), "purix-sandbox-rm-"));
  process.chdir(tmpDir);
  writeFileSync(join(tmpDir, "keep.rs"), "fn keep() {}\n");
  writeFileSync(join(tmpDir, "gone.rs"), "fn gone() {}\n");
});
afterEach(() => {
  closeDb();
  process.chdir(originalCwd);
  safeRmSync(tmpDir);
});

// A provider that fails when gone.rs is still in the copy it is asked to check: what a compiler does when something imports it.
let sawGoneFile = false;
const provider: LanguageProvider = {
  id: "fakedel",
  minSupportedVersion: "1.0.0",
  detect: () => false,
  verify: (filePaths) => {
    sawGoneFile = existsSync(join(dirname(filePaths[0]!), "gone.rs"));
    return sawGoneFile ? { status: "fail", reason: "gone.rs is still there" } : { status: "pass", isolation: "none" };
  },
  runTests: () => ({ status: "pass", quarantinedFailures: [] }),
  checkIdiom: () => ({ ran: true, findings: [] }),
  auditDependencies: async () => ({ pinning: [], vulnerabilities: [], ran: false }),
  getFingerprint: async () => ({}),
};

describe("verifyInSandbox: removePaths", () => {
  const change = [{ path: "keep.rs", new_content: "fn keep() { /* uses nothing */ }\n" }];

  it("without removePaths the deleted file is still in the copy (the false pass this prevents)", () => {
    registerLanguageProvider(provider);
    const r = verifyInSandbox("c", change, tmpDir, "fakedel");
    expect(sawGoneFile).toBe(true);
    expect(r.status).toBe("fail");
  });

  it("with removePaths the file is absent from the copy while the real project keeps it", () => {
    registerLanguageProvider(provider);
    const r = verifyInSandbox("c", change, tmpDir, "fakedel", ["gone.rs"]);
    expect(sawGoneFile).toBe(false);
    expect(r.status).toBe("pass");
    expect(existsSync(join(tmpDir, "gone.rs"))).toBe(true);
  });

  it("a removePath that leaves the project is a policy failure, not a delete outside the copy", () => {
    registerLanguageProvider(provider);
    const r = verifyInSandbox("c", change, tmpDir, "fakedel", ["../escape.rs"]);
    expect(r.status).toBe("fail");
    expect(r.status === "fail" && r.policyBlock).toBe(true);
  });
});
