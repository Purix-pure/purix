// src/manifest/audit_export.test.ts
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAuditTrail, formatAuditTrailJson } from "./audit_export";
import { closeDb } from "./store";

describe("Audit Export", () => {
  // buildAuditTrail opens the project store in the current folder. Run it in a throwaway folder so no `.purix` is left in the
  // package folder (plan section 4, rule 4).
  let cwd: string;
  let dir: string;
  beforeEach(() => { cwd = process.cwd(); dir = mkdtempSync(join(tmpdir(), "purix-audit-export-")); process.chdir(dir); });
  afterEach(() => { closeDb(); process.chdir(cwd); rmSync(dir, { recursive: true, force: true }); });

  it("builds audit trail report", () => {
    const report = buildAuditTrail();
    expect(report).toBeTruthy();
    const json = formatAuditTrailJson(report);
    expect(typeof json).toBe("string");
  });
});
