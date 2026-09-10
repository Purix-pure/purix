// src/security/audit_tamper_evidence.test.ts
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAuditRecord, verifyAuditChain, exportAuditChainJson } from "./audit_tamper_evidence";
import { closeDb, getDbCompat as getDb } from "../manifest/store";

describe("ADR-042 Audit Log Tamper-Evidence & Retention", () => {
  let originalCwd: string;
  let tmpDir: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpDir = mkdtempSync(join(tmpdir(), "purix-audit-test-"));
    process.chdir(tmpDir);
  });

  afterEach(() => {
    closeDb();
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("appends records and verifies hash chain integrity successfully", () => {
    appendAuditRecord({ event: "commit_landed", component_id: "c1" });
    appendAuditRecord({ event: "commit_landed", component_id: "c2" });

    const verification = verifyAuditChain();
    expect(verification.valid).toBe(true);
  });

  it("detects direct tampering with database rows", () => {
    appendAuditRecord({ event: "commit_landed", component_id: "c1" });
    appendAuditRecord({ event: "commit_landed", component_id: "c2" });

    // Tamper directly with underlying row
    const db = getDb();
    db.run(`UPDATE audit_chain SET payload = '{"tampered":true}' WHERE id = 1`);

    const verification = verifyAuditChain();
    expect(verification.valid).toBe(false);
    expect(verification.reason).toMatch(/Hash mismatch/);
  });

  it("produces valid export format", () => {
    appendAuditRecord({ event: "test" });
    const jsonStr = exportAuditChainJson();
    const parsed = JSON.parse(jsonStr);
    expect(parsed.data.records.length).toBe(1);
    expect(parsed.data.records[0].payload).toContain("test");
  });
});
