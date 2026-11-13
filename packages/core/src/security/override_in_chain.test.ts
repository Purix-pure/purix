// A2a-1: override decisions are inside the audit chain, so editing or deleting override_audits rows is detected (research 08, finding 3).
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getDbCompat } from "../manifest/store.js";
import { recordOverrideAudit, getOverrideAudits, verifyOverrideAudits } from "./override_audit.js";
import { readAuditChain, verifyAuditChain } from "./audit_tamper_evidence.js";
import { safeRmSync } from "../platform/fs_retry.js";

describe("override audit inside the chain", () => {
  let cwd: string;
  let dir: string;
  beforeEach(() => {
    cwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), "purix-ovr-"));
    process.chdir(dir);
  });
  afterEach(() => {
    closeDb();
    process.chdir(cwd);
    safeRmSync(dir);
  });

  it("an override adds one chain record carrying who, which gate, why and what", () => {
    const e = recordOverrideAudit("TrustGate", "reviewed by hand", "touches src/auth", "alice");
    const rows = readAuditChain().rows.map((r) => JSON.parse(r.payload));
    const hit = rows.find((p) => p.event === "override");
    expect(hit).toMatchObject({ event: "override", override_id: e.id, actor: "alice", gate_name: "TrustGate", reason: "reviewed by hand", finding: "touches src/auth" });
    expect(verifyAuditChain().valid).toBe(true);
  });

  it("an empty reason is still refused and writes nothing to either place", () => {
    expect(() => recordOverrideAudit("TrustGate", "  ", "f")).toThrow(/reason/);
    expect(readAuditChain().rows.length).toBe(0);
    expect(getOverrideAudits().length).toBe(0);
  });

  it("verifyOverrideAudits is clean when table and chain agree", () => {
    recordOverrideAudit("SecurityGate", "r1", "f1");
    recordOverrideAudit("BudgetGate", "r2", "f2");
    expect(verifyOverrideAudits()).toMatchObject({ ok: true, checked: 2, problems: [] });
  });

  it("editing a row is caught", () => {
    recordOverrideAudit("TrustGate", "real reason", "f");
    getDbCompat().run(`UPDATE override_audits SET reason='edited', actor='someone'`);
    const v = verifyOverrideAudits();
    expect(v.ok).toBe(false);
    expect(v.problems.join(" ")).toMatch(/differs|edited/i);
  });

  it("deleting every row is caught (the chain still remembers)", () => {
    recordOverrideAudit("TrustGate", "r", "f");
    getDbCompat().run(`DELETE FROM override_audits`);
    const v = verifyOverrideAudits();
    expect(v.ok).toBe(false);
    expect(v.problems.join(" ")).toMatch(/missing/i);
  });
});
