// A2a-1: the audit-chain check runs at startup, a failure is written where a person can read it (not stderr only), and the
// signed export has a production caller.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeRmSync } from "../platform/fs_retry.js";
import { closeDb, getDbCompat, storeExists } from "../manifest/store.js";
import { appendAuditRecord } from "../security/audit_tamper_evidence.js";
import { recordOverrideAudit } from "../security/override_audit.js";
import { runAuditExportNow, runAuditVerifyNow, readAuditVerifyStatus, startScheduler, stopScheduler } from "./scheduler.js";

describe("scheduled audit maintenance", () => {
  let cwd: string;
  let dir: string;
  let userDir: string;
  let saved: string | undefined;
  beforeEach(() => {
    cwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), "purix-sched-audit-"));
    userDir = mkdtempSync(join(tmpdir(), "purix-sched-user-"));
    saved = process.env.PURIX_USER_DIR;
    process.env.PURIX_USER_DIR = userDir;
    process.chdir(dir);
  });
  afterEach(() => {
    stopScheduler();
    closeDb();
    process.chdir(cwd);
    if (saved === undefined) delete process.env.PURIX_USER_DIR;
    else process.env.PURIX_USER_DIR = saved;
    safeRmSync(dir);
    safeRmSync(userDir);
  });

  it("no store: reports 'no_store' and creates nothing", () => {
    const s = runAuditVerifyNow();
    expect(s.state).toBe("no_store");
    expect(storeExists()).toBe(false);
  });

  it("an intact chain is written as ok, with the record count", () => {
    appendAuditRecord({ n: 1 });
    appendAuditRecord({ n: 2 });
    const s = runAuditVerifyNow();
    expect(s).toMatchObject({ state: "ok", records: 2 });
    expect(readAuditVerifyStatus()).toMatchObject({ state: "ok", records: 2 });
  });

  it("a cut tail is a failure that is stored for status and doctor, not only printed", () => {
    for (let i = 0; i < 6; i++) appendAuditRecord({ n: i });
    getDbCompat().run(`DELETE FROM audit_chain WHERE id > 3`);
    const s = runAuditVerifyNow();
    expect(s.state).toBe("failed");
    expect(s.problems.join(" ")).toMatch(/removed from the end|receipt/i);
    expect(readAuditVerifyStatus()?.state).toBe("failed");
  });

  it("an edited override row is a failure too", () => {
    recordOverrideAudit("TrustGate", "real", "f");
    getDbCompat().run(`UPDATE override_audits SET reason='changed'`);
    const s = runAuditVerifyNow();
    expect(s.state).toBe("failed");
    expect(s.problems.join(" ")).toMatch(/override/i);
  });

  it("startScheduler runs the check once at start, before the first poll", () => {
    appendAuditRecord({ n: 1 });
    expect(readAuditVerifyStatus()).toBeNull();
    startScheduler(false);
    expect(readAuditVerifyStatus()).toMatchObject({ state: "ok" });
  });

  it("a status written by an earlier run is not mistaken for this one: it carries its time", () => {
    appendAuditRecord({ n: 1 });
    const s = runAuditVerifyNow();
    expect(Number.isNaN(Date.parse(s.checkedAt))).toBe(false);
  });

  it("the export is signed with an install key, written to the state folder, and the key is not the old public default", () => {
    appendAuditRecord({ event: "x" });
    const out = runAuditExportNow();
    expect(out.state).toBe("written");
    if (out.state !== "written") return;
    expect(existsSync(out.path)).toBe(true);
    const parsed = JSON.parse(readFileSync(out.path, "utf-8"));
    expect(parsed.data.records.length).toBe(1);
    const key = readFileSync(join(userDir, "audit-export.key"), "utf-8").trim();
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    const sig = createHmac("sha256", key).update(JSON.stringify(parsed.data)).digest("hex");
    expect(parsed.signature).toBe(sig);
    expect(createHmac("sha256", "audit-export-secret").update(JSON.stringify(parsed.data)).digest("hex")).not.toBe(parsed.signature);
  });

  it("export with no store writes nothing", () => {
    expect(runAuditExportNow().state).toBe("no_store");
  });
});

describe("audit check when the store is busy (H5)", () => {
  it("a lock is reported as 'busy', is not written as a failure, and leaves the last real verdict in place", () => {
    const cwd = process.cwd();
    const dir = mkdtempSync(join(tmpdir(), "purix-sched-busy-"));
    const userDir = mkdtempSync(join(tmpdir(), "purix-sched-busy-user-"));
    const saved = process.env.PURIX_USER_DIR;
    process.env.PURIX_USER_DIR = userDir;
    process.chdir(dir);
    try {
      appendAuditRecord({ n: 1 });
      expect(runAuditVerifyNow().state).toBe("ok");
      const busy = runAuditVerifyNow({ verifyChain: () => { throw new Error("database is locked"); } });
      expect(busy.state).toBe("busy");
      expect(busy.problems).toEqual([]);
      expect(readAuditVerifyStatus()?.state).toBe("ok"); // the busy answer was not stored over the real one
      const real = runAuditVerifyNow({ verifyChain: () => { throw new Error("database disk image is malformed"); } });
      expect(real.state).toBe("failed");
    } finally {
      stopScheduler(); closeDb(); process.chdir(cwd);
      if (saved === undefined) delete process.env.PURIX_USER_DIR; else process.env.PURIX_USER_DIR = saved;
      safeRmSync(dir); safeRmSync(userDir);
    }
  });
});
