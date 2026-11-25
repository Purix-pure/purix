// A secret-scan stop and a security-gate stop each leave one structured `policy_block` event, with names and counts only.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyInSandbox } from "./sandbox.js";
import { closeDb, getDb, storeExists } from "../manifest/store.js";
import { listEvents } from "../manifest/events.js";
import { registerLanguageProvider } from "../language/registry.js";
import type { LanguageProvider } from "../language/provider.js";
import { safeRmSync } from "../platform/fs_retry.js";

const provider: LanguageProvider = {
  id: "pbevent", minSupportedVersion: "1.0.0", detect: () => false,
  verify: () => ({ status: "pass", isolation: "none" }),
  runTests: () => ({ status: "pass", quarantinedFailures: [] }),
  checkIdiom: () => ({ ran: true, findings: [] }),
  auditDependencies: async () => ({ pinning: [], vulnerabilities: [], ran: false }),
  getFingerprint: async () => ({}),
};

let cwd: string, dir: string;
beforeEach(() => {
  cwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "purix-pbevent-"));
  process.chdir(dir);
  registerLanguageProvider(provider);
  getDb(); // a store exists, so events are recorded
});
afterEach(() => { closeDb(); process.chdir(cwd); safeRmSync(dir); });

const run = (content: string) => verifyInSandbox("c", [{ path: "src/a.ts", new_content: content }], dir, "pbevent");

describe("policy_block event", () => {
  it("a secret-scan stop records one event naming the pattern, never the value", () => {
    const key = "AKIA" + "IOSFODNN7EXAMPLQ";
    const r = run(`export const k = "${key}";\n`);
    expect(r.status).toBe("fail");
    const ev = listEvents({ kind: "policy_block" });
    expect(ev.length).toBe(1);
    expect(ev[0]!.component_id).toBe("c");
    expect(ev[0]!.detail["source"]).toBe("secret_scan");
    expect(Number(ev[0]!.detail["findings"])).toBeGreaterThan(0);
    expect(JSON.stringify(ev[0]!.detail)).not.toContain(key);
  });

  it("a security-gate stop records one event with the category", () => {
    const r = run('db.query("SELECT * FROM u WHERE id = " + id);\n');
    expect(r.status).toBe("fail");
    const ev = listEvents({ kind: "policy_block" });
    expect(ev.length).toBe(1);
    expect(ev[0]!.detail["source"]).toBe("security_gate");
    expect(ev[0]!.detail["categories"]).toEqual({ "SQL Injection": 1 });
  });

  it("a clean change records no policy_block event", () => {
    const r = run("export const version = 1;\n");
    expect(r.status).toBe("pass");
    expect(listEvents({ kind: "policy_block" }).length).toBe(0);
  });
});

// Reading and recording follow the same rule everywhere in Purix: a folder with no store gets no store from a policy block.
describe("policy_block event in a folder with no Purix store", () => {
  it("the change is still stopped, and no store is created", () => {
    closeDb();
    process.chdir(cwd);
    safeRmSync(dir);
    const bare = mkdtempSync(join(tmpdir(), "purix-pbevent-bare-"));
    process.chdir(bare);
    try {
      expect(storeExists()).toBe(false);
      const key = "AKIA" + "IOSFODNN7EXAMPLQ";
      const r = verifyInSandbox("c", [{ path: "src/a.ts", new_content: `export const k = "${key}";\n` }], bare, "pbevent");
      expect(r.status).toBe("fail");
      expect(storeExists()).toBe(false);
    } finally {
      process.chdir(cwd);
      safeRmSync(bare);
      dir = mkdtempSync(join(tmpdir(), "purix-pbevent-")); // afterEach removes this one
    }
  });
});
