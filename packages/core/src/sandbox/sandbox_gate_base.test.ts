// F03-05 at the choke point: verifyInSandbox hands the security gate what each file held before the change, so an old finding
// does not block an unrelated edit. A new finding, a new file, and a path that leaves the project are all still judged whole.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyInSandbox } from "./sandbox.js";
import { closeDb } from "../manifest/store.js";
import { registerLanguageProvider } from "../language/registry.js";
import type { LanguageProvider } from "../language/provider.js";
import { safeRmSync } from "../platform/fs_retry.js";

const provider: LanguageProvider = {
  id: "gatebase", minSupportedVersion: "1.0.0", detect: () => false,
  verify: () => ({ status: "pass", isolation: "none" }),
  runTests: () => ({ status: "pass", quarantinedFailures: [] }),
  checkIdiom: () => ({ ran: true, findings: [] }),
  auditDependencies: async () => ({ pinning: [], vulnerabilities: [], ran: false }),
  getFingerprint: async () => ({}),
};

let cwd: string, dir: string, outside: string;
beforeEach(() => {
  cwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "purix-gatebase-"));
  outside = mkdtempSync(join(tmpdir(), "purix-gatebase-outside-"));
  process.chdir(dir);
  registerLanguageProvider(provider);
});
afterEach(() => { closeDb(); process.chdir(cwd); safeRmSync(dir); safeRmSync(outside); });

const OLD = "exec(cmd, cb);\n";
const run = (path: string, content: string) => verifyInSandbox("c", [{ path, new_content: content }], dir, "gatebase");

describe("verifyInSandbox and pre-existing security findings (F03-05)", () => {
  it("an unrelated edit to a file that already has a finding is not blocked", () => {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "a.ts"), OLD);
    const r = run("src/a.ts", OLD + "export const version = 2;\n");
    expect(r.status).toBe("pass");
  });

  it("a new finding added to that file is blocked as a policy block", () => {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "a.ts"), OLD);
    const r = run("src/a.ts", OLD + 'db.query("SELECT * FROM u WHERE id = " + id);\n');
    expect(r.status).toBe("fail");
    if (r.status === "fail") expect(r.policyBlock).toBe(true);
  });

  it("a new file has no base: its finding blocks", () => {
    const r = run("src/new.ts", OLD);
    expect(r.status).toBe("fail");
    if (r.status === "fail") expect(r.policyBlock).toBe(true);
  });

  it("a path that leaves the project gets no base, so the file outside cannot excuse a finding", () => {
    writeFileSync(join(outside, "x.ts"), OLD);
    const rel = join("..", outside.split("/").pop()!, "x.ts");
    const r = run(rel, OLD + "export const v = 1;\n");
    expect(r.status).toBe("fail");
    if (r.status === "fail") expect(r.policyBlock).toBe(true);
  });

  it("a base too large to read cheaply is not used: the file is judged whole", () => {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "big.ts"), OLD + "// " + "x".repeat(6 * 1024 * 1024) + "\n");
    const r = run("src/big.ts", OLD + "export const v = 1;\n");
    expect(r.status).toBe("fail");
  });
});

describe("a link inside the project that points outside (F03-05)", () => {
  it("does not lend its target's content as the base", async () => {
    const { symlinkSync } = await import("node:fs");
    writeFileSync(join(outside, "target.ts"), OLD);
    mkdirSync(join(dir, "src"));
    symlinkSync(join(outside, "target.ts"), join(dir, "src", "link.ts"));
    const r = run("src/link.ts", OLD + "export const v = 1;\n");
    expect(r.status).toBe("fail");
    if (r.status === "fail") expect(r.policyBlock).toBe(true);
  });
});
