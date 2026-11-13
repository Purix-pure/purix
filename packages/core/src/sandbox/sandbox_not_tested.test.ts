// A verification that passed but exercised nothing must say so ("not tested"), not look like a clean pass.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyInSandbox } from "./sandbox.js";
import { closeDb } from "../manifest/store.js";
import { registerLanguageProvider } from "../language/registry.js";
import type { LanguageProvider } from "../language/provider.js";
import { safeRmSync } from "../platform/fs_retry.js";

let cwd: string, dir: string, logs: string[], realLog: typeof console.log;
beforeEach(() => { cwd = process.cwd(); dir = mkdtempSync(join(tmpdir(), "purix-nottested-")); process.chdir(dir); logs = []; realLog = console.log; console.log = (...a: unknown[]) => { logs.push(a.join(" ")); }; });
afterEach(() => { console.log = realLog; closeDb(); process.chdir(cwd); safeRmSync(dir); });

const provider = (id: string, runTests: LanguageProvider["runTests"]): LanguageProvider => ({
  id, minSupportedVersion: "1.0.0", detect: () => false,
  verify: () => ({ status: "pass", isolation: "none" }),
  runTests,
  checkIdiom: () => ({ ran: true, findings: [] }),
  auditDependencies: async () => ({ pinning: [], vulnerabilities: [], ran: false }),
  getFingerprint: async () => ({}),
});

describe("verifyInSandbox reports what was not tested", () => {
  it("a pass with uncovered files carries them in notTested and prints a warning", () => {
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
    registerLanguageProvider(provider("nottested_a", () => ({ status: "no_tests", reason: "none", quarantinedFailures: [], discovery: { tests: [], uncovered: ["a.ts"], truncated: false } })));
    const r = verifyInSandbox("c", [{ path: "component.nottested_a", new_content: "x" }], dir, "nottested_a");
    expect(r.status).toBe("pass");
    expect(r.status === "pass" && r.notTested).toEqual(["a.ts"]);
    expect(logs.join("\n")).toContain("Not tested");
  });
  it("a fully covered pass has no notTested field and prints no warning", () => {
    registerLanguageProvider(provider("nottested_b", () => ({ status: "pass", quarantinedFailures: [], discovery: { tests: ["a.test.ts"], uncovered: [], truncated: false } })));
    const r = verifyInSandbox("c", [{ path: "component.nottested_b", new_content: "x" }], dir, "nottested_b");
    expect(r.status === "pass" && r.notTested).toBeUndefined();
    expect(logs.join("\n")).not.toContain("Not tested");
  });
  it("F06-05: a pass whose test search was cut off lists the changed files and says why, in words that are true for that case", () => {
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
    registerLanguageProvider(provider("nottested_cut", () => ({ status: "pass", quarantinedFailures: [], discovery: { tests: ["a.test.ts"], uncovered: [], truncated: true } })));
    const r = verifyInSandbox("c", [{ path: "component.nottested_cut", new_content: "x" }], dir, "nottested_cut");
    expect(r.status).toBe("pass");
    expect(r.status === "pass" && r.notTested?.length).toBeGreaterThan(0);
    const out = logs.join("\n");
    expect(out).toContain("Not tested");
    expect(out).toContain("file limit");
    expect(out).not.toContain("no test is related");
  });
  it("F06-05: a finished search never mentions the file limit", () => {
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
    registerLanguageProvider(provider("nottested_nocut", () => ({ status: "no_tests", reason: "none", quarantinedFailures: [], discovery: { tests: [], uncovered: ["a.ts"], truncated: false } })));
    verifyInSandbox("c", [{ path: "component.nottested_nocut", new_content: "x" }], dir, "nottested_nocut");
    expect(logs.join("\n")).not.toContain("file limit");
  });
});
